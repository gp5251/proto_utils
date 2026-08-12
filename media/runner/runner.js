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

  // UI 文案:host 在 boot.strings 里按显示语言下发,缺键回退英文默认;{name} 占位符运行时替换。
  var STRING_DEFAULTS = {
    copy: 'Copy',
    copied: 'Copied',
    refreshed: 'Refreshed · {count} services',
    refreshedErrors: 'Refreshed · {count} services · {errors} parse errors',
    chunkCount: '{count} messages',
    ignored: 'Ignored: {fields}',
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
        applyLoadError(msg.errors);
        break;
      case 'callResult':
        if (component) component.applyCallResult(msg.payload);
        break;
      case 'streamChunk':
        if (component) component.applyStreamChunk(msg);
        break;
      case 'streamEnd':
        if (component) component.applyStreamEnd(msg);
        break;
      case 'prefill':
        pendingPrefill = { service: msg.service, method: msg.method };
        tryApplyPrefill();
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
    store.state = 'ready';
    endRefresh(store, str('refreshed', { count: store.services.length }));
    tryApplyPrefill();
  }

  function applyLoadError(errors) {
    var store = workbenchStore();
    store.errors = Array.isArray(errors) ? errors : [String(errors)];
    endRefresh(store, str('refreshedErrors', { count: store.services.length, errors: store.errors.length }));
    // 致命错误时 services 不会再来,停掉 loading 让错误卡片 + 空态可见
    if (store.services.length === 0) {
      store.state = 'ready';
    }
  }

  // 刷新反馈:完成提示短暂显示后自动消失;后到的提示覆盖先到的
  var noticeTimer = 0;
  function endRefresh(store, notice) {
    if (!store.refreshing) {
      return; // 非刷新触发(初次加载/watcher 自动刷新)不打扰
    }
    store.refreshing = false;
    store.refreshNotice = notice;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      store.refreshNotice = '';
      noticeTimer = 0;
    }, 2500);
  }

  function tryApplyPrefill() {
    if (!pendingPrefill || !component) {
      return;
    }
    if (component.openMethod(pendingPrefill.service, pendingPrefill.method)) {
      pendingPrefill = null;
    }
  }

  document.addEventListener('alpine:init', function () {
    Alpine.store('search', { query: '' });
    Alpine.store('str', boot.strings && typeof boot.strings === 'object' ? boot.strings : {});
    Alpine.store('workbench', {
      state: Array.isArray(boot.services) ? 'ready' : 'loading',
      services: Array.isArray(boot.services) ? boot.services : [],
      errors: [],
      server: typeof boot.server === 'string' ? boot.server : '',
      protoDir: typeof boot.protoDir === 'string' ? boot.protoDir : '',
      refreshing: false,
      refreshNotice: '',
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

      streamDurationText: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return ((s && s.durationMs) || 0) + 'ms';
      },

      streamChunkCountText: function (svcName, methodName) {
        var s = this.getStream(svcName, methodName);
        return str('chunkCount', { count: (s && s.chunks && s.chunks.length) || 0 });
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
        // 仅 JSON 页签下需要先合并再发;无参方法直发 {}
        if (this.showJsonPane(key, method) && !this.applyJsonToForm(key, method)) {
          return;
        }
        this.submitCall(svcName, methodName, method);
      },

      filteredServices: function () {
        var services = Alpine.store('workbench').services;
        var q = this.query.trim().toLowerCase();
        if (!q) return services;
        return services.filter(function (svc) {
          if (fuzzyMatch(q, svc.name)) return true;
          if (svc.fullName && fuzzyMatch(q, svc.fullName)) return true;
          return svc.methods.some(function (m) {
            return fuzzyMatch(q, m.name);
          });
        });
      },

      filteredMethods: function (svc) {
        var q = this.query.trim().toLowerCase();
        if (!q) return svc.methods;
        if (fuzzyMatch(q, svc.name)) return svc.methods;
        if (svc.fullName && fuzzyMatch(q, svc.fullName)) return svc.methods;
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
        this.expandedServices = Object.assign({}, this.expandedServices, { [svc.name]: true });
        var key = this.methodKey(svc.name, method.name);
        this.ensureFormValues(key, method);
        this.expandedMethod = key;
        this.$nextTick(function () {
          var el = document.getElementById('method-' + svc.name + '-' + method.name);
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

      visibleSchemaRows: function (rows) {
        var result = [];
        var self = this;
        for (var i = 0; i < (rows || []).length; i++) {
          var row = rows[i];
          result.push(row);
          if (self.isRowOpen(row.path) && row.children && row.children.length) {
            result.push.apply(result, self.visibleSchemaRows(row.children));
          }
        }
        return result;
      },

      // ---- 调用:postMessage 替代 fetch /api/call ----

      submitCall: function (svcName, methodName, method) {
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
        });
      },

      startStream: function (svcName, methodName) {
        var key = this.methodKey(svcName, methodName);
        this.setResult(key, null);
        this.setCopied(key, false);
        this.streams = Object.assign({}, this.streams, {
          [key]: { chunks: [], done: false, cancelled: false, durationMs: 0 },
        });
        sendMessage({
          type: 'callStream',
          service: svcName,
          method: methodName,
          values: this.formValues[key] || {},
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
        this.setLoading(key, false);
        var stream = this.streams[key];
        if (stream) {
          this.streams = Object.assign({}, this.streams, {
            [key]: Object.assign({}, stream, { done: true }),
          });
        }
      },

      applyStreamChunk: function (msg) {
        var key = this.methodKey(msg.service, msg.method);
        var stream = this.streams[key];
        if (!stream) {
          stream = { chunks: [], done: false, cancelled: false, durationMs: 0 };
        }
        this.streams = Object.assign({}, this.streams, {
          [key]: Object.assign({}, stream, { chunks: stream.chunks.concat([msg.data]) }),
        });
      },

      applyStreamEnd: function (msg) {
        var key = this.methodKey(msg.service, msg.method);
        var stream = this.streams[key];
        if (!stream) {
          return;
        }
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

      copyServiceName: function (svcName) {
        navigator.clipboard.writeText(svcName);
        this.copiedServiceName = svcName;
        var self = this;
        setTimeout(function () {
          self.copiedServiceName = null;
        }, 2000);
      },

      isServiceCopied: function (svcName) {
        return this.copiedServiceName === svcName;
      },
    };
    });
  });
})();
