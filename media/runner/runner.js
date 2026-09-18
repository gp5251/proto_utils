/* RPC 工作台 Webview 脚本 —— Alpine 组件移植自 rpc_runner views/home.ejs。
   网络点全部改为 postMessage:
     fetch /api/call            → {type:'call'} / {type:'callStream'} / {type:'cancelStream'}
     fetch /api/services/status → 取消轮询,扩展推送 {type:'services'} / {type:'loadError'}
     EventSource /api/events    → 扩展推送刷新;顶栏「刷新」按钮发 {type:'refresh'}
   协议见 src/runner/webviewPanel.ts 的 WebviewToWorkbench / WorkbenchToWebview。 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var boot = window.__PROTO_UTILS_BOOT__ || {};

  // 0.3.65 序列/服务页流接收上限缺省(与宿主 config.ts DEFAULT_SEQ_STREAM_CHUNK_LIMIT 同步);0 = 不限
  var SEQ_STREAM_CAP_DEFAULT = 100;

  // UI 文案:host 在 boot.strings 里按显示语言下发,缺键回退英文默认;{name} 占位符运行时替换。
  var STRING_DEFAULTS = {
    copy: 'Copy',
    copied: 'Copied',
    refreshed: 'Refreshed · {count} services',
    refreshedErrors: 'Refreshed · {count} services · {errors} parse errors',
    chunkCount: '{count} messages',
    ignored: 'Ignored: {fields}',
    emptyLoadError: 'Unknown load error (empty message)',
    prefillMiss: 'Call target not found: {service} · {method}. The service list may be outdated — click Refresh.',
    connUnreachable: 'Server unreachable',
    svcUnavailable: 'Service unavailable — click Refresh to retry',
    connRestored: 'Connection restored',
    connLost: 'Connection lost',
    // 0.3.62 手动「刷新服务」回执
    connProbeOk: 'Service reachable',
    connProbeFail: 'Service unreachable',
    // 调用序列(0.3.59,ADR-0012)
    seqNameRequired: 'Enter a sequence name to save',
    seqAdded: 'Added to sequence: {method}',
    seqEmpty: 'Sequence has no steps',
    seqLoadMiss: 'Sequence not found',
    seqValidationFailed: '{count} step(s) reference missing methods. Sequence not started.',
    seqCompleted: 'Sequence completed',
    seqAborted: 'Sequence aborted at a failed step',
    seqStopped: 'Sequence stopped',
  };

  function str(key, vars) {
    var store = typeof Alpine !== 'undefined' ? Alpine.store('str') : null;
    var template = (store && store[key]) || STRING_DEFAULTS[key] || key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] != null ? String(vars[k]) : '';
    });
  }

  // 模糊匹配:query 字符按序出现在 target 中即命中(子序列,大小写不敏感)。
  // 子串命中是子序列的子集——替换 includes 不丢旧匹配,只多不少。
  function fuzzyMatch(query, target) {
    if (!query || !target) return !query;
    var lower = target.toLowerCase();
    var qi = 0;
    for (var ti = 0; ti < lower.length && qi < query.length; ti++) {
      if (lower[ti] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  // 服务名命中:短名走模糊;fullName(包限定名)只收「子串」或「单个点分段内模糊」。
  // 整串 fullName 跑跨段子序列会让短词散字命中包名段(trace → au[t]oshop.p[r]oject.v1.[a]utoshop.[c]ommunicat[e]...),
  // 全部服务命中、filteredMethods 又因服务命中返回全方法——过滤列表看似完全无效(0.3.58 实证)。
  // ponytail:跨段子序列有意不收;包名检索走子串(含点),段内容错走 fuzzy,天花板是段内打散顺序仍命中。
  function matchServiceName(query, svc) {
    if (fuzzyMatch(query, svc.name)) return true;
    if (!svc.fullName) return false;
    var lower = svc.fullName.toLowerCase();
    if (lower.indexOf(query) > -1) return true;
    return lower.split('.').some(function (seg) {
      return fuzzyMatch(query, seg);
    });
  }

  // webview postMessage 走结构化克隆:Alpine 的响应式数据是 Proxy,直接发会
  // DataCloneError(调用卡死在发送中的根因)。所有出站消息一律先深克隆为纯对象。
  // 注意不能覆写 vscode.postMessage —— acquireVsCodeApi 返回的对象是只读的。
  function sendMessage(message) {
    vscode.postMessage(JSON.parse(JSON.stringify(message)));
  }

  // homePage 组件实例(alpine:init 后可用)与待应用的 prefill。
  // prefill 可能先于 services 到达(CodeLens 入口),先存起来,services 到达后应用。
  var component = null;
  var pendingPrefill = null;

  window.addEventListener('message', function (event) {
    routeMessage(event.data);
  });

  function routeMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'loading':
        workbenchStore().state = 'loading';
        break;
      case 'services':
        applyServices(msg.payload);
        break;
      case 'loadError':
        applyLoadError(msg.errors, msg.segments);
        break;
      case 'callResult':
        if (component) component.applyCallResult(msg.payload);
        break;
      case 'streamChunk':
        if (component) component.applyStreamChunk(msg);
        break;
      case 'streamHeaders':
      case 'streamTrailers':
        if (component) component.applyStreamMeta(msg);
        break;
      case 'streamEnd':
        if (component) component.applyStreamEnd(msg);
        break;
      case 'prefill':
        pendingPrefill = { service: msg.service, method: msg.method };
        tryApplyPrefill();
        break;
      case 'connState': {
        // host 侧连通性探测结果(0.3.54):顶栏状态点 unknown=灰/ok=绿/fail=红
        var connStore = workbenchStore();
        var prevConn = connStore.connState;
        var nextConn = msg.state === 'ok' ? 'ok' : 'fail';
        connStore.connState = nextConn;
        // 0.3.57:跃迁瞬时提醒——fail→ok 恢复,ok→fail 断开;unknown 首探不打扰
        if (prevConn === 'fail' && nextConn === 'ok') showNotice(connStore, str('connRestored'));
        if (prevConn === 'ok' && nextConn === 'fail') showNotice(connStore, str('connLost'));
        // 0.3.62 手动「刷新服务」回执:仅手动探测才提醒,周期复探不打扰
        if (connStore.probingServices) {
          connStore.probingServices = false;
          showNotice(connStore, str(nextConn === 'ok' ? 'connProbeOk' : 'connProbeFail'));
        }
        break;
      }
      case 'seqEvent':
        if (component) component.applySeqEvent(msg.event);
        break;
      case 'sequences':
        if (component) component.applySequences(msg.list);
        break;
      case 'sequenceLoaded':
        if (component) component.applySequenceLoaded(msg.sequence);
        break;
      case 'sequenceStoreError':
        if (component) component.showSeqNotice(msg.message);
        break;
    }
  }

  function workbenchStore() {
    return Alpine.store('workbench');
  }

  function applyServices(payload) {
    var store = workbenchStore();
    store.services = Array.isArray(payload) ? payload : [];
    store.errors = [];
    store.errorSegs = [];
    store.prefillNotice = '';
    store.state = 'ready';
    endRefresh(store, str('refreshed', { count: store.services.length }));
    tryApplyPrefill();
  }

  function applyLoadError(errors, segments) {
    var store = workbenchStore();
    store.errors = Array.isArray(errors) ? errors : [String(errors)];
    // 0.3.40:出错点分段由扩展侧 parseProtoError 预解析;旧协议缺 segments 退化为整行纯文本段。
    // 空消息守卫:空串错误/空文本 segments 会渲染出空白红卡(「报错但看不到原因」),
    // 逐行兜底为可见文本。
    var segsArr = Array.isArray(segments) && segments.length === store.errors.length ? segments : null;
    store.errorSegs = store.errors.map(function (e, i) {
      var segs = segsArr ? segsArr[i] : null;
      var segText = Array.isArray(segs) ? segs.map(function (s) { return (s && s.text) || ''; }).join('') : '';
      if (segText.trim()) {
        return segs;
      }
      var text = e == null ? '' : String(e);
      return [{ text: text.trim() ? text : str('emptyLoadError') }];
    });
    endRefresh(store, str('refreshedErrors', { count: store.services.length, errors: store.errors.length }));
    // 致命错误时 services 不会再来,停掉 loading 让错误卡片 + 空态可见
    if (store.services.length === 0) {
      store.state = 'ready';
    }
  }

  // 瞬时通知:refreshNotice 显示 2.5s 后自动消失;后到的提示覆盖先到的
  var noticeTimer = 0;
  function showNotice(store, notice) {
    store.refreshNotice = notice;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      store.refreshNotice = '';
      noticeTimer = 0;
    }, 2500);
  }

  // 刷新反馈:完成提示短暂显示后自动消失;后到的提示覆盖先到的
  function endRefresh(store, notice) {
    if (!store.refreshing) {
      return; // 非刷新触发(初次加载/watcher 自动刷新)不打扰
    }
    store.refreshing = false;
    showNotice(store, notice);
  }

  function tryApplyPrefill() {
    if (!pendingPrefill || !component) {
      return;
    }
    if (component.openMethod(pendingPrefill.service, pendingPrefill.method)) {
      // CodeLens 跳入视同重新定位:清掉残留搜索词。
      // 面板 retainContextWhenHidden,旧查询会跨次存活;openMethod 查的是未过滤的
      // store.services,过滤态下能"开"成功但目标行被搜索隐藏,必须清。
      Alpine.store('search').query = '';
      workbenchStore().prefillNotice = '';
      pendingPrefill = null;
      return;
    }
    // miss(0.3.45):服务列表里查不到目标——典型为改名未保存/列表未就绪。
    // 必须可见并丢弃滞留:零反馈会让用户以为按钮坏了;滞留则下次刷新会突然跳旧目标。
    var missed = pendingPrefill;
    pendingPrefill = null;
    workbenchStore().prefillNotice = str('prefillMiss', { service: missed.service, method: missed.method });
  }

  document.addEventListener('alpine:init', function () {
    Alpine.store('search', { query: '' });
    Alpine.store('str', boot.strings && typeof boot.strings === 'object' ? boot.strings : {});
    Alpine.store('workbench', {
      state: Array.isArray(boot.services) ? 'ready' : 'loading',
      services: Array.isArray(boot.services) ? boot.services : [],
      errors: [],
      errorSegs: [],
      prefillNotice: '',
      server: typeof boot.server === 'string' ? boot.server : '',
      protoDir: typeof boot.protoDir === 'string' ? boot.protoDir : '',
      refreshing: false,
      refreshNotice: '',
      // 0.3.62 手动「刷新服务」(仅探测)进行中;connState 回执后收尾
      probingServices: false,
      // 后端连通性:unknown=未探测(灰),host 推 connState 后转 ok(绿)/fail(红)
      connState: 'unknown',
      // 顶视图切换(0.3.59):'services' 方法浏览 | 'sequence' 调用序列
      view: 'services',
    });

    // 顶栏刷新区:@alpinejs/csp 表达式见不到 window 全局(0.3.19 前的 postRefresh 全局入口因此从未生效),
    // 与 homePage 同约定,组件经 Alpine.data 注册,方法体可自由访问 window
    Alpine.data('pageMeta', function () {
      return {
        refresh() {
          var store = workbenchStore();
          if (store.refreshing) {
            return;
          }
          store.refreshing = true;
          store.refreshNotice = '';
          sendMessage({ type: 'refresh' });
        },
        // 0.3.62 刷新服务:仅重探连接,不重解析 proto;回执走 connState
        refreshServices() {
          var store = workbenchStore();
          if (store.probingServices) {
            return;
          }
          store.probingServices = true;
          sendMessage({ type: 'refreshServices' });
        },
      };
    });

    // @alpinejs/csp 不回退全局作用域,组件必须经 Alpine.data 注册(标准版 Alpine 才能用 window.homePage)
    Alpine.data('homePage', function () {
    return {
      query: '',
      expandedServices: {},
      expandedMethod: null,
      expandedRows: {},
      formValues: {},
      results: {},
      streams: {},
      loading: {},
      copied: {},
      copiedMethodKey: null,
      copiedServiceName: null,
      editorMode: {},
      jsonText: {},
      jsonError: {},
      jsonWarnings: {},
      formErrors: {},
      headers: {},
      respMeta: {},

      // ---- 调用序列(0.3.59,ADR-0012) ----
      // seqSteps: [{id, service, method, responseStream}];每步入参/模式存编辑器状态字典(键=id),支持同方法重复
      seqSteps: [],
      seqIdSeq: 0,
      seqName: '',
      seqSaved: [],
      seqRunning: false,
      // 0.3.62 已点停止/结束并继续、等底层收尾中:按钮转「正在停止…」防重复点击并给即时反馈
      seqStopping: false,
      seqStatus: 'idle',
      seqNotice: '',
      // seqReport: index → {status, service, method, responseStream, values, durationMs, body, chunks, error}
      seqReport: {},
      // 序列内二级 tab(0.3.62):'steps' 步骤编辑 | 'report' 运行报告
      seqTab: 'steps',
      // 0.3.63 步骤入参折叠态:step.id → bool,缺省(无记录) = 折叠
      seqStepOpen: {},
      // 0.3.64 步级流接收上限输入值(step.id → 字符串);空 = 缺省 100
      seqMaxMsgs: {},

      // ---- 响应 JSON 折叠树(0.3.41):行构建与可见性遍历在 TS(全局 ResultTree) ----
      // resultTrees: methodKey → 根行数组(一元,applyCallResult 一次构建)
      // streamTrees: methodKey → 每 chunk 一列行数组(append 时只建新 chunk,旧列引用不变)
      // chunkSizes:  methodKey → 各 chunk 字节数(append 时算一次,chunk 标签免每渲染 stringify)
      // treeOpen:    methodKey → { nodes: {[path]: true}, chunks: {[idx]: true} },默认全折叠
      resultTrees: {},
      streamTrees: {},
      chunkSizes: {},
      treeOpen: {},

      // ---- Headers(请求 metadata)行编辑器:初始行来自 boot.metadata(runner.metadata 配置) ----

      getHeaders: function (key, noGlobal) {
        var rows = this.headers[key];
        if (!rows) {
          // noGlobal(0.3.64 序列步级覆盖):初始为空,仅记覆盖项;服务页仍从全局 metadata 初始化
          var initial = !noGlobal && Array.isArray(boot.metadata) ? boot.metadata : [];
          rows = initial.map(function (e) {
            return { key: String((e && e.key) || ''), value: String((e && e.value) || '') };
          });
          this.headers = Object.assign({}, this.headers, { [key]: rows });
        }
        return rows;
      },

      addHeaderRow: function (key, noGlobal) {
        var rows = this.getHeaders(key, noGlobal).slice();
        rows.push({ key: '', value: '' });
        this.headers = Object.assign({}, this.headers, { [key]: rows });
      },

      removeHeaderRow: function (key, idx) {
        var rows = this.getHeaders(key).slice();
        rows.splice(idx, 1);
        this.headers = Object.assign({}, this.headers, { [key]: rows });
      },

      setHeaderField: function (key, idx, field, value) {
        var rows = this.getHeaders(key).map(function (row, i) {
          if (i !== idx) return row;
          return { key: field === 'key' ? value : row.key, value: field === 'value' ? value : row.value };
        });
        this.headers = Object.assign({}, this.headers, { [key]: rows });
      },

      // 发送前收敛:空 key 行丢弃,value 统一为字符串
      collectMetadata: function (key) {
        var rows = this.getHeaders(key);
        var out = [];
        for (var i = 0; i < rows.length; i++) {
          var k = (rows[i].key || '').trim();
          if (!k) continue;
          out.push({ key: k, value: rows[i].value == null ? '' : String(rows[i].value) });
        }
        return out;
      },

      init: function () {
        component = this;
        var self = this;
        var store = Alpine.store('search');
        this.query = store.query;
        Alpine.effect(function () {
          var q = store.query;
          if (self.query !== q) self.query = q;
        });
        sendMessage({ type: 'ready' });
      },

      methodKey: function (svcName, methodName) {
        return svcName + '.' + methodName;
      },

      // 服务身份:fullName 恒唯一——跨包同短名服务(v1.UserService / v2.UserService)
      // 的卡片 key、状态字典与消息路由互不串线;显示名仍是短名 svc.name。
      svcId: function (svc) {
        return (svc && svc.fullName) || svc.name;
      },

      isLoading: function (svcName, methodName) {
        return !!this.loading[this.methodKey(svcName, methodName)];
      },

      isCopied: function (svcName, methodName) {
        return !!this.copied[this.methodKey(svcName, methodName)];
      },

      getResult: function (svcName, methodName) {
        return this.results[this.methodKey(svcName, methodName)] ?? null;
      },

      getStream: function (svcName, methodName) {
        return this.streams[this.methodKey(svcName, methodName)] ?? null;
      },

      // ---- 响应 metadata(headers/trailers):折叠块,默认收起,有数据才渲染 ----

      getRespMeta: function (svcName, methodName) {
        return this.respMeta[this.methodKey(svcName, methodName)] ?? null;
      },

      setRespMeta: function (key, patch) {
        var prev = this.respMeta[key] || { headers: [], trailers: [], open: false };
        this.respMeta = Object.assign({}, this.respMeta, { [key]: Object.assign({}, prev, patch) });
      },

      hasRespMeta: function (svcName, methodName) {
        var m = this.getRespMeta(svcName, methodName);
        return Boolean(m && (m.headers.length > 0 || m.trailers.length > 0));
      },

      isRespMetaOpen: function (svcName, methodName) {
        var m = this.getRespMeta(svcName, methodName);
        return Boolean(m && m.open);
      },

      toggleRespMeta: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var m = this.getRespMeta(svcName, methodName);
        this.setRespMeta(key, { open: !(m && m.open) });
      },

      respMetaCountText: function (svcName, methodName) {
        var m = this.getRespMeta(svcName, methodName);
        if (!m) return '';
        return String(m.headers.length + m.trailers.length);
      },

      respMetaEntries: function (svcName, methodName) {
        var m = this.getRespMeta(svcName, methodName);
        if (!m) return [];
        var out = [];
        var collect = function (source) {
          return function (e) {
            out.push({ source: source, key: String((e && e.key) || ''), value: String((e && e.value) || '') });
          };
        };
        m.headers.forEach(collect(str('respMetaHeader')));
        m.trailers.forEach(collect(str('respMetaTrailer')));
        return out;
      },

      // ---- 响应 JSON 折叠树(0.3.41):状态机粘合,行构建/可见性在全局 ResultTree ----

      // 一元成功且带结构化 data 时才挂树;错误/缺 data 走原始 <pre> 兜底
      resultTreeAvailable: function (svcName, methodName) {
        return !!this.resultTrees[this.methodKey(svcName, methodName)];
      },

      resultTreeRows: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var rows = this.resultTrees[key] || [];
        var nodes = (this.treeOpen[key] && this.treeOpen[key].nodes) || {};
        return window.ResultTree.visibleRows(rows, function (path) {
          return nodes[path] === true;
        });
      },

      isTreeNodeOpen: function (svcName, methodName, path) {
        var t = this.treeOpen[this.methodKey(svcName, methodName)];
        return Boolean(t && t.nodes[path] === true);
      },

      toggleTreeNode: function (svcName, methodName, path) {
        var key = this.methodKey(svcName, methodName);
        var t = this.treeOpen[key] || { nodes: {}, chunks: {} };
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: Object.assign({}, t, {
            nodes: Object.assign({}, t.nodes, { [path]: !t.nodes[path] }),
          }),
        });
      },

      isChunkTreeOpen: function (svcName, methodName, idx) {
        var t = this.treeOpen[this.methodKey(svcName, methodName)];
        return Boolean(t && t.chunks[idx] === true);
      },

      toggleChunkTree: function (svcName, methodName, idx) {
        var key = this.methodKey(svcName, methodName);
        var t = this.treeOpen[key] || { nodes: {}, chunks: {} };
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: Object.assign({}, t, {
            chunks: Object.assign({}, t.chunks, { [idx]: !t.chunks[idx] }),
          }),
        });
      },

      // 流式:每 chunk 一条折叠条(#绝对序号 · 大小);字节数 append 时已缓存,渲染零 stringify。
      // 序号带 dropped 偏移:窗口滑出最旧块后,展开态(treeOpen.chunks)按绝对序号仍稳定。
      chunkSections: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var sizes = this.chunkSizes[key] || [];
        var dropped = (this.streams[key] && this.streams[key].dropped) || 0;
        return sizes.map(function (size, i) {
          var abs = dropped + i;
          return { idx: abs, label: window.ResultTree.formatChunkLabel(abs, size) };
        });
      },

      // 收起的 chunk 返回 []:闭块挂零 DOM 行。chunk 间共享节点展开态(同型消息同构展开)
      chunkTreeRows: function (svcName, methodName, idx) {
        var key = this.methodKey(svcName, methodName);
        var t = this.treeOpen[key];
        if (!t || t.chunks[idx] !== true) return [];
        var dropped = (this.streams[key] && this.streams[key].dropped) || 0;
        var rows = (this.streamTrees[key] || [])[idx - dropped] || [];
        if (rows.length === 0) return []; // 已被窗口挤出的早期块
        return window.ResultTree.visibleRows(rows, function (path) {
          return t.nodes[path] === true;
        });
      },

      // 流式树可用:有 chunk 且不是错误结果
      streamIsTreeable: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var stream = this.streams[key];
        var result = this.results[key];
        return Boolean(
          stream && stream.chunks && stream.chunks.length > 0 &&
          (!result || !result.result || result.result.status !== 'error'),
        );
      },

      // 全部展开/收起(0.3.42):展开 = 容器路径全集置 true;收起 = 清空(根行一并收合,只余根行)

      expandAllResult: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var t = this.treeOpen[key] || { nodes: {}, chunks: {} };
        var nodes = {};
        window.ResultTree.collectContainerPaths(this.resultTrees[key] || []).forEach(function (p) {
          nodes[p] = true;
        });
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: Object.assign({}, t, { nodes: nodes }),
        });
      },

      collapseAllResult: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var t = this.treeOpen[key] || { nodes: {}, chunks: {} };
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: Object.assign({}, t, { nodes: {} }),
        });
      },

      // 流式:折叠条与条内节点一并展开/收起(全部展开 = 所见即全部数据)
      expandAllChunks: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var dropped = (this.streams[key] && this.streams[key].dropped) || 0;
        var nodes = {};
        (this.streamTrees[key] || []).forEach(function (rows) {
          window.ResultTree.collectContainerPaths(rows).forEach(function (p) {
            nodes[p] = true;
          });
        });
        var chunks = {};
        (this.chunkSizes[key] || []).forEach(function (_size, i) {
          chunks[dropped + i] = true;
        });
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: { nodes: nodes, chunks: chunks },
        });
      },

      collapseAllChunks: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        this.treeOpen = Object.assign({}, this.treeOpen, {
          [key]: { nodes: {}, chunks: {} },
        });
      },

      // ---- @alpinejs/csp 表达式解析器不支持 ?. / ??,结果区取值收敛到这里(纯 JS,随便写) ----

      resultStatusIs: function (svcName, methodName, status) {
        var r = this.getResult(svcName, methodName);
        return Boolean(r && r.result && r.result.status === status);
      },

      resultStatusIsNot: function (svcName, methodName, status) {
        var r = this.getResult(svcName, methodName);
        return !(r && r.result && r.result.status === status);
      },

      resultDurationText: function (svcName, methodName) {
        var r = this.getResult(svcName, methodName);
        return ((r && r.result && r.result.durationMs) || 0) + 'ms';
      },

      resultBodyText: function (svcName, methodName) {
        var r = this.getResult(svcName, methodName);
        return (r && r.resultBody) || '';
      },

      streamIsLive: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return Boolean(s && !s.done);
      },

      streamIsDone: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return Boolean(s && s.done);
      },

      streamIsCancelled: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return Boolean(s && s.done && s.cancelled);
      },

      // 0.3.64 收满上限自动停:展示为「完成」而非「已取消」
      streamIsCapped: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return Boolean(s && s.capped);
      },

      streamDurationText: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return ((s && s.durationMs) || 0) + 'ms';
      },

      streamChunkCountText: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        // 计数含已被窗口挤出的早期块:总量真实
        var total = s ? (s.chunks ? s.chunks.length : 0) + (s.dropped || 0) : 0;
        return str('chunkCount', { count: total });
      },

      setLoading: function (key, value) {
        this.loading = Object.assign({}, this.loading, { [key]: value });
      },

      setJsonText: function (key, value) {
        this.jsonText = Object.assign({}, this.jsonText, { [key]: value });
      },

      setJsonError: function (key, value) {
        this.jsonError = Object.assign({}, this.jsonError, { [key]: value });
      },

      setJsonWarnings: function (key, value) {
        this.jsonWarnings = Object.assign({}, this.jsonWarnings, { [key]: value });
      },

      // ---- 表单模式发送前校验(0.3.44):问题清单展示在发送按钮上方 ----

      getFormError: function (key) {
        return this.formErrors[key] || '';
      },

      setFormError: function (key, value) {
        this.formErrors = Object.assign({}, this.formErrors, { [key]: value });
      },

      setResult: function (key, value) {
        this.results = Object.assign({}, this.results, { [key]: value });
      },

      setCopied: function (key, value) {
        this.copied = Object.assign({}, this.copied, { [key]: value });
      },

      fieldTypeLabel: function (f) {
        var type = f.refType || f.type;
        if (f.label === 'repeated') {
          type += '[]';
        }
        return type;
      },

      enumOptionLabel: function (opt, options) {
        var NBSP = '\u00A0';
        var padEnd = function (text, width) {
          return text.length >= width ? text : text + NBSP.repeat(width - text.length);
        };
        var padStart = function (text, width) {
          return text.length >= width ? text : NBSP.repeat(width - text.length) + text;
        };
        var nameWidth = options.reduce(function (max, item) {
          return Math.max(max, item.name.length);
        }, opt.name.length);
        var numberWidth = options.reduce(function (max, item) {
          return Math.max(max, String(item.number).length);
        }, String(opt.number).length);
        var label = padEnd(opt.name, nameWidth) + NBSP + NBSP + padStart(String(opt.number), numberWidth);
        if (opt.comment) {
          label += NBSP.repeat(4) + '—' + NBSP.repeat(4) + opt.comment;
        }
        return label;
      },

      fieldSchemaRows: function (field) {
        if (!field.nestedFields || !field.nestedFields.length) return [];
        return this.buildSchemaRows(field.nestedFields, field.name, 1);
      },

      buildSchemaRows: function (fields, prefix, depth) {
        prefix = prefix || '';
        depth = depth || 0;
        var self = this;
        var rows = [];
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          var path = prefix ? prefix + '.' + f.name : f.name;
          var row = {
            kind: 'field',
            path: path,
            depth: depth,
            name: f.name,
            typeLabel: self.fieldTypeLabel(f),
            optional: !!f.optional,
            comment: f.comment,
          };
          if (f.protoType === 'TYPE_ENUM' && f.enumValues) row.enumValues = f.enumValues;
          if (f.protoType === 'TYPE_MESSAGE' && f.nestedFields && f.nestedFields.length) {
            row.children = self.buildSchemaRows(f.nestedFields, path, depth + 1);
          }
          rows.push(row);
        }
        return rows;
      },

      flattenFormFields: function (fields, prefix, depth) {
        prefix = prefix || '';
        depth = depth || 0;
        var rows = [];
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          var path = prefix ? prefix + '.' + f.name : f.name;
          if (f.protoType === 'TYPE_MESSAGE' && f.nestedFields && f.nestedFields.length && f.label !== 'repeated') {
            rows.push({ kind: 'group', field: f, path: path, depth: depth });
            rows.push.apply(rows, this.flattenFormFields(f.nestedFields, path, depth + 1));
          } else {
            rows.push({ kind: 'input', field: f, path: path, depth: depth });
          }
        }
        return rows;
      },

      initFieldValues: function (fields) {
        var values = {};
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          if (f.protoType === 'TYPE_MESSAGE' && f.nestedFields && f.nestedFields.length && f.label !== 'repeated') {
            values[f.name] = this.initFieldValues(f.nestedFields);
          } else if (f.protoType === 'TYPE_BOOL') {
            values[f.name] = false;
          } else {
            values[f.name] = '';
          }
        }
        return values;
      },

      getFieldValue: function (key, path) {
        var parts = path.split('.');
        var obj = this.formValues[key];
        for (var i = 0; i < parts.length; i++) {
          if (obj == null) return '';
          obj = obj[parts[i]];
        }
        return obj ?? '';
      },

      setFieldValue: function (key, path, value) {
        if (!this.formValues[key]) {
          this.formValues = Object.assign({}, this.formValues, { [key]: {} });
        }
        var parts = path.split('.');
        var obj = this.formValues[key];
        for (var i = 0; i < parts.length - 1; i++) {
          if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') {
            obj[parts[i]] = {};
          }
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
        // 用户改动即清除旧的表单校验问题(重新发送时会再算)
        if (this.formErrors[key]) this.setFormError(key, '');
        this.formValues = Object.assign({}, this.formValues, { [key]: this.formValues[key] });
      },

      // ---- 表单|JSON 双模式编辑器(同步自 rpc_runner 702879a;映射逻辑在 window.FormMapping) ----

      getEditorMode: function (key) {
        return this.editorMode[key] || 'form';
      },

      showFormPane: function (key, method) {
        return method.requestFields.length > 0 && this.getEditorMode(key) === 'form';
      },

      showJsonPane: function (key, method) {
        // 无参方法不显示 JSON 编辑框(也无 Tab),只留发送按钮
        return method.requestFields.length > 0 && this.getEditorMode(key) === 'json';
      },

      getJsonText: function (key) {
        return this.jsonText[key] || '';
      },

      getJsonError: function (key) {
        return this.jsonError[key] || '';
      },

      hasJsonWarnings: function (key) {
        var w = this.jsonWarnings[key];
        return !!(w && w.length);
      },

      jsonWarningText: function (key) {
        return str('ignored', { fields: (this.jsonWarnings[key] || []).join(', ') });
      },

      setEditorMode: function (key, mode, method) {
        if (this.getEditorMode(key) === mode) {
          return;
        }
        if (mode === 'json') {
          // 切到 JSON:从当前表单生成 JSON 文本(无参方法不显示 Tab,不会进这里)
          var text = JSON.stringify(window.FormMapping.formValuesToJson(method.requestFields, this.formValues[key] || {}), null, 2);
          this.setJsonText(key, text);
          this.setJsonError(key, null);
          this.setJsonWarnings(key, []);
        } else {
          // 切回表单:把 JSON 填进表单;无效 JSON 不动表单、留在 JSON 页显示错误
          if (!this.applyJsonToForm(key, method)) {
            return;
          }
        }
        this.editorMode = Object.assign({}, this.editorMode, { [key]: mode });
      },

      onJsonInput: function (key, value) {
        this.setJsonText(key, value);
        var check = window.FormMapping.validateJsonText(value);
        this.setJsonError(key, check.ok ? null : check.error);
        this.setJsonWarnings(key, []);
      },

      applyJsonToForm: function (key, method) {
        var text = this.jsonText[key] || '';
        var r = window.FormMapping.applyJsonText(method.requestFields, text, this.formValues[key] || {});
        if (!r.ok) {
          this.setJsonError(key, r.error);
          return false;
        }
        this.formValues = Object.assign({}, this.formValues, { [key]: r.values });
        this.setJsonError(key, null);
        this.setJsonWarnings(key, r.warnings);
        return true;
      },

      sendFromEditor: function (svcName, methodName, method) {
        var key = this.methodKey(svcName, methodName);
        this.setFormError(key, '');
        // 仅 JSON 页签下需要先合并再发;无参方法直发 {}
        if (this.showJsonPane(key, method)) {
          if (!this.applyJsonToForm(key, method)) {
            return;
          }
        } else if (method.requestFields.length > 0) {
          // 表单页签:发送前逐字段校验(数字/base64/JSON 数组/嵌套 message),问题清单就地展示
          var problems = window.FormMapping.validateFormValues(method.requestFields, this.formValues[key] || {});
          if (problems.length) {
            this.setFormError(key, problems.join('；'));
            return;
          }
        }
        this.submitCall(svcName, methodName, method);
      },

      filteredServices: function () {
        var services = Alpine.store('workbench').services;
        var q = this.query.trim().toLowerCase();
        if (!q) return services;
        return services.filter(function (svc) {
          if (matchServiceName(q, svc)) return true;
          return svc.methods.some(function (m) {
            return fuzzyMatch(q, m.name);
          });
        });
      },

      filteredMethods: function (svc) {
        var q = this.query.trim().toLowerCase();
        if (!q) return svc.methods;
        if (matchServiceName(q, svc)) return svc.methods;
        return svc.methods.filter(function (m) {
          return fuzzyMatch(q, m.name);
        });
      },

      toggleService: function (name) {
        this.expandedServices = Object.assign({}, this.expandedServices, {
          [name]: !this.isServiceOpen(name),
        });
      },

      isServiceOpen: function (name) {
        return this.expandedServices[name] !== false;
      },

      toggleMethod: function (svcName, methodName, method) {
        var key = this.methodKey(svcName, methodName);
        if (this.expandedMethod === key) {
          this.expandedMethod = null;
          return;
        }
        this.ensureFormValues(key, method);
        this.expandedMethod = key;
      },

      // prefill 入口:等同于用户手选(展开服务 + 展开方法表单 + 滚动到位)。幂等,只开不合。
      openMethod: function (serviceName, methodName) {
        var services = Alpine.store('workbench').services;
        var svc = null;
        for (var i = 0; i < services.length; i++) {
          if (services[i].name === serviceName || services[i].fullName === serviceName) {
            svc = services[i];
            break;
          }
        }
        if (!svc) return false;
        var method = null;
        for (var j = 0; j < svc.methods.length; j++) {
          if (svc.methods[j].name === methodName) {
            method = svc.methods[j];
            break;
          }
        }
        if (!method) return false;
        var id = this.svcId(svc);
        this.expandedServices = Object.assign({}, this.expandedServices, { [id]: true });
        var key = this.methodKey(id, method.name);
        this.ensureFormValues(key, method);
        this.expandedMethod = key;
        this.$nextTick(function () {
          var el = document.getElementById('method-' + id + '-' + method.name);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return true;
      },

      ensureFormValues: function (key, method) {
        if (this.formValues[key]) {
          return;
        }
        if (method.requestFields.length === 0) {
          this.formValues = Object.assign({}, this.formValues, { [key]: {} });
          return;
        }
        this.formValues = Object.assign({}, this.formValues, {
          [key]: this.initFieldValues(method.requestFields),
        });
      },

      isMethodOpen: function (svcName, methodName) {
        return this.expandedMethod === this.methodKey(svcName, methodName);
      },

      toggleRow: function (path) {
        this.expandedRows = Object.assign({}, this.expandedRows, { [path]: !this.isRowOpen(path) });
      },

      isRowOpen: function (path) {
        return this.expandedRows[path] === true;
      },

      // 展开态键 = 作用域前缀 + 行路径:响应区(res)/请求嵌套 schema(reqs)/请求表单(reqf)
      // 三处同路径互不串扰(此前共享一个 expandedRows 字典,同名嵌套字段会联动开合)
      rowKey: function (scope, path) {
        return scope + ':' + path;
      },

      visibleSchemaRows: function (rows, scope) {
        var result = [];
        var self = this;
        var prefix = scope ? scope + ':' : '';
        for (var i = 0; i < (rows || []).length; i++) {
          var row = rows[i];
          result.push(row);
          if (self.isRowOpen(prefix + row.path) && row.children && row.children.length) {
            result.push.apply(result, self.visibleSchemaRows(row.children, scope));
          }
        }
        return result;
      },

      // ---- 调用:postMessage 替代 fetch /api/call ----

      submitCall: function (svcName, methodName, method) {
        // 探测不可达禁发(0.3.54):与按钮 disabled 契约一致,在唯一 choke point 拦下
        // Enter 提交/脚本直调的绕过(一元/流式共用,同 isLoading 早退的教训)
        if (workbenchStore().connState === 'fail') {
          return;
        }
        // 发送中早退:Enter 表单提交经 @submit.prevent 直连这里,绕过按钮 disabled,
        // 在唯一 choke point 拦下(一元/流式共用),与按钮禁用态契约一致
        if (this.isLoading(svcName, methodName)) {
          return;
        }
        if (method && method.requestStream) {
          return; // client/bidi 流不支持(ADR-0007),按钮已禁用,双保险
        }
        if (method && method.responseStream) {
          this.startStream(svcName, methodName);
          return;
        }
        var key = this.methodKey(svcName, methodName);
        this.setLoading(key, true);
        this.setCopied(key, false);
        sendMessage({
          type: 'call',
          service: svcName,
          method: methodName,
          values: this.formValues[key] || {},
          metadata: this.collectMetadata(key),
        });
      },

      startStream: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        // 流式发送态:按钮变「发送中...」并禁用,流结束/取消/出错经 applyStreamEnd/applyCallResult 复位
        this.setLoading(key, true);
        this.setResult(key, null);
        this.setCopied(key, false);
        // 折叠树态随流重置:旧 chunk 行/字节缓存与展开态一并清零(0.3.41)
        this.streamTrees = Object.assign({}, this.streamTrees, { [key]: [] });
        this.chunkSizes = Object.assign({}, this.chunkSizes, { [key]: [] });
        this.treeOpen = Object.assign({}, this.treeOpen, { [key]: { nodes: {}, chunks: {} } });
        this.setRespMeta(key, { headers: [], trailers: [], open: false });
        this.streams = Object.assign({}, this.streams, {
          [key]: { chunks: [], done: false, cancelled: false, durationMs: 0, dropped: 0 },
        });
        sendMessage({
          type: 'callStream',
          service: svcName,
          method: methodName,
          values: this.formValues[key] || {},
          metadata: this.collectMetadata(key),
        });
      },

      cancelStream: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var stream = this.streams[key];
        if (stream) {
          this.streams = Object.assign({}, this.streams, {
            [key]: Object.assign({}, stream, { cancelled: true }),
          });
        }
        sendMessage({ type: 'cancelStream', service: svcName, method: methodName });
      },

      applyCallResult: function (payload) {
        if (!payload || typeof payload.service !== 'string' || typeof payload.method !== 'string') {
          return;
        }
        var key = this.methodKey(payload.service, payload.method);
        this.setResult(key, payload);
        // 0.3.41:一元成功且带结构化 data → 一次构建折叠树;根行种子展开(顶层键可见),
        // 整条替换 = 重调重置展开态。错误/无 data 清掉上次成功的树,退原始 <pre>
        // (否则失败徽标旁会挂着上一次响应的旧树)。
        if (payload.result && payload.result.status === 'ok' && payload.result.data !== undefined) {
          this.resultTrees = Object.assign({}, this.resultTrees, {
            [key]: window.ResultTree.buildResultTree(payload.result.data),
          });
          this.treeOpen = Object.assign({}, this.treeOpen, {
            [key]: { nodes: { '': true }, chunks: {} },
          });
        } else {
          this.resultTrees = Object.assign({}, this.resultTrees, { [key]: null });
        }

        this.setLoading(key, false);
        this.setRespMeta(key, {
          headers: Array.isArray(payload.responseHeaders) ? payload.responseHeaders : [],
          trailers: Array.isArray(payload.responseTrailers) ? payload.responseTrailers : [],
        });
        var stream = this.streams[key];
        if (stream) {
          this.streams = Object.assign({}, this.streams, {
            [key]: Object.assign({}, stream, { done: true }),
          });
        }
      },

      applyStreamMeta: function (msg) {
        var key = this.methodKey(msg.service, msg.method);
        if (msg.type === 'streamHeaders') {
          this.setRespMeta(key, { headers: Array.isArray(msg.headers) ? msg.headers : [] });
        } else {
          this.setRespMeta(key, { trailers: Array.isArray(msg.trailers) ? msg.trailers : [] });
        }
      },

      applyStreamChunk: function (msg) {
        var key = this.methodKey(msg.service, msg.method);
        var stream = this.streams[key];
        if (!stream) {
          stream = { chunks: [], done: false, cancelled: false, durationMs: 0, dropped: 0 };
        }
        // 有界窗口(0.3.44):只保留最近 MAX_STREAM_CHUNKS 条的原始数据/树行/字节数,
        // 长流不再无限吃内存与 DOM;dropped 记账供绝对序号偏移
        var max = window.ResultTree.MAX_STREAM_CHUNKS;
        var rc = window.ResultTree.pushBounded(stream.chunks, msg.data, max);
        var rt = window.ResultTree.pushBounded(
          this.streamTrees[key] || [],
          window.ResultTree.buildResultTree(msg.data),
          max,
        );
        var rs = window.ResultTree.pushBounded(
          this.chunkSizes[key] || [],
          new TextEncoder().encode(JSON.stringify(msg.data)).length,
          max,
        );
        this.streams = Object.assign({}, this.streams, {
          [key]: Object.assign({}, stream, { chunks: rc.items, done: false, dropped: (stream.dropped || 0) + rc.dropped }),
        });
        this.streamTrees = Object.assign({}, this.streamTrees, { [key]: rt.items });
        this.chunkSizes = Object.assign({}, this.chunkSizes, { [key]: rs.items });
        // 0.3.64 服务页流方法收满上限自动停:cap>0 且总量达标 → 取消流并按「完成」态展示(capped)
        // 0.3.65 空值 = 缺省上限(此前误为不限)
        var cap = this.seqMaxMsgsValue(key);
        if (cap === null) cap = SEQ_STREAM_CAP_DEFAULT;
        var total = rc.items.length + ((stream.dropped || 0) + rc.dropped);
        var cur = this.streams[key];
        if (cap > 0 && total >= cap && cur && !cur.done && !cur.capped) {
          this.streams = Object.assign({}, this.streams, { [key]: Object.assign({}, cur, { capped: true }) });
          showNotice(workbenchStore(), str('streamCapReached', { count: total }));
          this.cancelStream(msg.service, msg.method);
        }
      },

      applyStreamEnd: function (msg) {
        var key = this.methodKey(msg.service, msg.method);
        var stream = this.streams[key];
        if (!stream) {
          return;
        }
        this.setLoading(key, false);
        this.streams = Object.assign({}, this.streams, {
          [key]: Object.assign({}, stream, { done: true, durationMs: msg.durationMs || 0 }),
        });
      },

      getStreamBody: function (svcName, methodName) {
        var result = this.getResult(svcName, methodName);
        if (result && result.result && result.result.status === 'error') {
          return result.resultBody || '';
        }
        var stream = this.getStream(svcName, methodName);
        if (!stream) {
          return '';
        }
        return stream.chunks
          .map(function (chunk) {
            return JSON.stringify(chunk, null, 2);
          })
          .join('\n\n');
      },

      copyStreamResult: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var body = this.getStreamBody(svcName, methodName);
        if (!body) return;
        navigator.clipboard.writeText(body);
        this.setCopied(key, true);
        var self = this;
        setTimeout(function () {
          self.setCopied(key, false);
        }, 2000);
      },

      copyResult: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        var result = this.getResult(svcName, methodName);
        var body = result ? result.resultBody : null;
        if (!body) return;
        navigator.clipboard.writeText(body);
        this.setCopied(key, true);
        var self = this;
        setTimeout(function () {
          self.setCopied(key, false);
        }, 2000);
      },

      copyMethodName: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        navigator.clipboard.writeText(methodName);
        this.copiedMethodKey = key;
        var self = this;
        setTimeout(function () {
          self.copiedMethodKey = null;
        }, 2000);
      },

      isMethodCopied: function (svcName, methodName) {
        return this.copiedMethodKey === this.methodKey(svcName, methodName);
      },

      copyServiceName: function (svc) {
        // 徽标态按身份记;剪贴板复制显示短名
        navigator.clipboard.writeText(svc.name);
        this.copiedServiceName = this.svcId(svc);
        var self = this;
        setTimeout(function () {
          self.copiedServiceName = null;
        }, 2000);
      },

      isServiceCopied: function (svc) {
        return this.copiedServiceName === this.svcId(svc);
      },

      // ---- 调用序列(0.3.59,ADR-0012) ----

      setView: function (v) {
        Alpine.store('workbench').view = v;
        if (v === 'sequence') this.requestSequences();
      },

      setSeqTab: function (v) {
        this.seqTab = v;
      },

      // 0.3.63 步骤入参默认折叠:缺省即折叠,点击展开
      isSeqStepOpen: function (id) {
        return this.seqStepOpen[id] === true;
      },

      toggleSeqStep: function (id) {
        this.seqStepOpen = Object.assign({}, this.seqStepOpen, { [id]: !this.isSeqStepOpen(id) });
      },

      lookupMethod: function (service, methodName) {
        var services = Alpine.store('workbench').services;
        for (var i = 0; i < services.length; i++) {
          if (services[i].name === service || services[i].fullName === service) {
            var ms = services[i].methods;
            for (var j = 0; j < ms.length; j++) {
              if (ms[j].name === methodName) return ms[j];
            }
          }
        }
        return null;
      },

      // 服务视图“加入序列”:把当前方法连同入参快照追加为一步(快照到该步自己的编辑器键,与源表单脱钩)
      addToSequence: function (svc, m) {
        var srcKey = this.methodKey(this.svcId(svc), m.name);
        this.ensureFormValues(srcKey, m);
        var id = 'seq' + (this.seqIdSeq++);
        var mode = this.getEditorMode(srcKey);
        this.seqSteps = this.seqSteps.concat([{
          id: id,
          service: this.svcId(svc),
          method: m.name,
          responseStream: !!m.responseStream,
        }]);
        this.formValues = Object.assign({}, this.formValues, { [id]: JSON.parse(JSON.stringify(this.formValues[srcKey] || {})) });
        this.editorMode = Object.assign({}, this.editorMode, { [id]: mode });
        this.jsonText = Object.assign({}, this.jsonText, { [id]: this.jsonText[srcKey] || '' });
        this.seqTab = 'steps'; // 新加的步在序列 tab 可见
        // 0.3.66 加入后不切视图,仅瞬时提示;避免打断服务页浏览
        showNotice(workbenchStore(), str('seqAdded', { method: m.name }));
      },

      removeStep: function (i) {
        this.seqSteps = this.seqSteps.filter(function (_s, idx) { return idx !== i; });
      },

      moveStep: function (i, dir) {
        var j = i + dir;
        if (j < 0 || j >= this.seqSteps.length) return;
        var arr = this.seqSteps.slice();
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        this.seqSteps = arr;
      },

      stepMethod: function (step) {
        return this.lookupMethod(step.service, step.method);
      },

      // 占位符静态标红:扫该步入参里的 {{...}},前向/自引用与结构非法列出(路径能否取到值属运行时,不在此判)
      stepRefProblems: function (step, index) {
        if (typeof window.Placeholder === 'undefined') return [];
        var mode = this.getEditorMode(step.id);
        var text = mode === 'json'
          ? this.getJsonText(step.id)
          : JSON.stringify(this.formValues[step.id] || {});
        if (!text) return [];
        return window.Placeholder.findInvalidRefs(text, index).map(function (b) {
          return b.raw + ' \u2014 ' + b.reason;
        });
      },

      buildSequencePayload: function () {
        var self = this;
        return {
          name: this.seqName,
          steps: this.seqSteps.map(function (s) {
            var mode = self.getEditorMode(s.id);
            var step = { service: s.service, method: s.method, mode: mode, responseStream: s.responseStream };
            if (mode === 'json') step.jsonText = self.getJsonText(s.id);
            else step.values = self.formValues[s.id] || {};
            // 0.3.64 步级 metadata 覆盖(编辑器初始空,故仅覆盖项)与流接收上限
            var md = self.collectMetadata(s.id);
            if (md.length) step.metadata = md;
            var mm = self.seqMaxMsgsValue(s.id);
            if (mm !== null) step.maxMessages = mm;
            return step;
          }),
        };
      },

      requestSequences: function () {
        sendMessage({ type: 'listSequences' });
      },

      runSequence: function () {
        if (workbenchStore().connState === 'fail') return;
        if (this.seqRunning) return;
        if (this.seqSteps.length === 0) { this.showSeqNotice(str('seqEmpty')); return; }
        this.seqReport = {};
        this.seqNotice = '';
        this.seqStatus = 'running';
        this.seqRunning = true;
        this.seqTab = 'report'; // 点运行立即切报告 tab,所见即所得
        sendMessage({ type: 'runSequence', sequence: this.buildSequencePayload() });
      },

      stopSequence: function () {
        if (this.seqStopping) return;
        this.seqStopping = true;
        sendMessage({ type: 'stopSequence' });
      },

      endSeqStream: function () {
        if (this.seqStopping) return;
        this.seqStopping = true;
        sendMessage({ type: 'endSequenceStream' });
      },

      // 当前是否有“运行中的流步骤”:常驻控件条上的「结束并继续」显隐门控。
      // 报告行内的同款按钮随 chunk 高频重渲染,点击可能被 DOM 重建吞掉;控件条不重渲染,点击必达(0.3.62)。
      seqHasRunningStream: function () {
        for (var k in this.seqReport) {
          var r = this.seqReport[k];
          if (r && r.status === 'running' && r.responseStream) return true;
        }
        return false;
      },

      saveSequence: function () {
        if (!(this.seqName || '').trim()) { this.showSeqNotice(str('seqNameRequired')); return; }
        if (this.seqSteps.length === 0) { this.showSeqNotice(str('seqEmpty')); return; }
        sendMessage({ type: 'saveSequence', sequence: this.buildSequencePayload() });
      },

      loadSequence: function (name) {
        sendMessage({ type: 'loadSequence', name: name });
      },

      deleteSequence: function (name) {
        sendMessage({ type: 'deleteSequence', name: name });
      },

      showSeqNotice: function (text) {
        this.seqNotice = text || '';
      },

      applySequences: function (list) {
        this.seqSaved = Array.isArray(list) ? list : [];
      },

      applySequenceLoaded: function (seq) {
        if (!seq) { this.showSeqNotice(str('seqLoadMiss')); return; }
        var self = this;
        this.seqName = seq.name || '';
        this.seqSteps = [];
        (seq.steps || []).forEach(function (st) {
          var id = 'seq' + (self.seqIdSeq++);
          var m = self.lookupMethod(st.service, st.method);
          self.seqSteps.push({ id: id, service: st.service, method: st.method, responseStream: !!st.responseStream });
          var mode = st.mode === 'json' ? 'json' : 'form';
          self.editorMode = Object.assign({}, self.editorMode, { [id]: mode });
          // 0.3.64 还原步级 metadata 覆盖与流接收上限
          self.headers = Object.assign({}, self.headers, {
            [id]: (st.metadata || []).map(function (e) { return { key: e.key, value: e.value }; }),
          });
          self.seqMaxMsgs = Object.assign({}, self.seqMaxMsgs, { [id]: st.maxMessages == null ? '' : String(st.maxMessages) });
          if (mode === 'json') {
            self.jsonText = Object.assign({}, self.jsonText, { [id]: st.jsonText || '' });
            self.formValues = Object.assign({}, self.formValues, { [id]: m ? self.initFieldValues(m.requestFields) : {} });
          } else {
            self.formValues = Object.assign({}, self.formValues, { [id]: st.values || (m ? self.initFieldValues(m.requestFields) : {}) });
          }
        });
        this.seqTab = 'steps'; // 加载后回到步骤编辑查看/调整
        Alpine.store('workbench').view = 'sequence';
      },

      // 引擎事件 → 序列报告(按步序号)
      applySeqEvent: function (ev) {
        if (!ev || typeof ev !== 'object') return;
        var rep;
        switch (ev.type) {
          case 'validationFailed':
            this.showSeqNotice(str('seqValidationFailed', { count: (ev.missing || []).length }));
            break;
          case 'stepStart':
            rep = Object.assign({}, this.seqReport);
            rep[ev.index] = {
              status: 'running', service: ev.service, method: ev.method,
              responseStream: ev.responseStream, values: ev.values, chunks: [], dropped: 0,
              maxMessages: typeof ev.maxMessages === 'number' ? ev.maxMessages : SEQ_STREAM_CAP_DEFAULT,
              body: '', error: '', durationMs: 0,
            };
            this.seqReport = rep;
            break;
          case 'stepChunk':
            rep = Object.assign({}, this.seqReport);
            if (rep[ev.index]) {
              // 0.3.64 按步上限有界(步级 maxMessages,0=不限),防长流撑爆报告区
              var rc = window.ResultTree.pushBounded(rep[ev.index].chunks || [], ev.data, rep[ev.index].maxMessages);
              rep[ev.index] = Object.assign({}, rep[ev.index], {
                chunks: rc.items,
                dropped: (rep[ev.index].dropped || 0) + rc.dropped,
              });
              this.seqReport = rep;
            }
            break;
          case 'stepUnaryResult': {
            rep = Object.assign({}, this.seqReport);
            var p = ev.payload || {};
            var ok = p.result && p.result.status === 'ok';
            rep[ev.index] = Object.assign({}, rep[ev.index], {
              status: ok ? 'ok' : 'error',
              body: p.resultBody || '',
              durationMs: (p.result && p.result.durationMs) || 0,
              error: ok ? '' : (p.resultBody || ''),
            });
            this.seqReport = rep;
            break;
          }
          case 'stepStreamEnd':
            rep = Object.assign({}, this.seqReport);
            rep[ev.index] = Object.assign({}, rep[ev.index], {
              status: ev.ok ? 'ok' : 'error', durationMs: ev.durationMs || 0, error: ev.ok ? '' : (ev.error || ''),
            });
            this.seqReport = rep;
            this.seqStopping = false; // 流步骤已收尾,解除「正在停止」
            break;
          case 'stepFailed':
            rep = Object.assign({}, this.seqReport);
            rep[ev.index] = Object.assign({}, rep[ev.index], { status: 'error', error: ev.error || '' });
            this.seqReport = rep;
            break;
          case 'end':
            this.seqRunning = false;
            this.seqStopping = false;
            this.seqStatus = ev.status;
            if (ev.status === 'completed') this.showSeqNotice(str('seqCompleted'));
            else if (ev.status === 'aborted') this.showSeqNotice(str('seqAborted'));
            else if (ev.status === 'stopped') this.showSeqNotice(str('seqStopped'));
            break;
        }
      },

      // 报告行(按当前 seqSteps 顺序对齐步序号)
      seqReportEntries: function () {
        var self = this;
        return this.seqSteps.map(function (s, i) {
          var r = self.seqReport[i];
          return {
            index: i, service: s.service, method: s.method,
            status: r ? r.status : 'pending',
            durationMs: r ? r.durationMs : 0,
            body: r ? r.body : '',
            error: r ? r.error : '',
            chunks: r ? r.chunks : [],
            dropped: r ? (r.dropped || 0) : 0,
            responseStream: s.responseStream,
          };
        });
      },

      seqStepTitle: function (entry) {
        return '#' + (entry.index + 1) + '  ' + entry.method;
      },

      // 报告卡可见性:任一步已启动(seqReport 有条目)即显示;@alpinejs/csp 不支持模板内函数表达式,收敛到这里
      hasSeqReport: function () {
        for (var k in this.seqReport) {
          if (Object.prototype.hasOwnProperty.call(this.seqReport, k)) return true;
        }
        return false;
      },

      seqChunkText: function (chunks) {
        return (chunks || []).map(function (c) { return JSON.stringify(c, null, 2); }).join('\n\n');
      },

      // 0.3.64 步级 maxMessages 解析:空/非法 = null(不写字段,引擎缺省 100);0 = 不限
      seqMaxMsgsValue: function (id) {
        var raw = (this.seqMaxMsgs[id] || '').trim();
        if (raw === '') return null;
        var n = Number(raw);
        if (!isFinite(n) || n < 0) return null;
        return Math.floor(n);
      },

      // 0.3.64 写入上限输入值:@alpinejs/csp 模板不支持内联 Object.assign 赋值,必须走方法
      setSeqMaxMsgs: function (id, value) {
        this.seqMaxMsgs = Object.assign({}, this.seqMaxMsgs, { [id]: value });
      },

      // 报告行 chunk 计数:含被挤出的早期块,总量真实(与单调用 streamChunkCountText 同语义)
      seqChunkCountText: function (entry) {
        var total = (entry.chunks ? entry.chunks.length : 0) + (entry.dropped || 0);
        return str('chunkCount', { count: total });
      },

      copySeqReport: function () {
        var self = this;
        var text = this.seqReportEntries().map(function (e) {
          var head = self.seqStepTitle(e) + '  [' + e.status + (e.durationMs ? ' ' + e.durationMs + 'ms' : '') + ']';
          var body = e.responseStream ? self.seqChunkText(e.chunks) : e.body;
          return head + '\n' + (body || e.error || '');
        }).join('\n\n');
        if (!text) return;
        navigator.clipboard.writeText(text);
      },
    };
    });
  });
})();
