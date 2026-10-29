import { randomBytes } from 'node:crypto';
import { env, l10n } from 'vscode';
import type { ServicesPayload } from './serviceRegistry';
import type { MetadataEntry } from './config';

export interface WorkbenchHtmlOptions {
  /** webview.cspSource,放行 asWebviewUri 资源 */
  cspSource: string;
  /** 每面板随机 nonce,CSP 与所有 <script> 标签共用 */
  nonce: string;
  /** media/runner/runner.css 的 asWebviewUri */
  stylesUri: string;
  /** media/runner/runner.js 的 asWebviewUri */
  runnerScriptUri: string;
  /** media/runner/formMapping.js 的 asWebviewUri(ADR-0009:build.mjs 从 src/runner/utils/formMapping.ts 产出) */
  formMappingScriptUri: string;
  /** media/runner/resultTree.js 的 asWebviewUri(0.3.41:响应 JSON 折叠树,同 ADR-0009 共享源通道) */
  resultTreeScriptUri: string;
  /** media/runner/placeholder.js 的 asWebviewUri(0.3.59:序列占位符编辑时标红,同 ADR-0009 共享源通道) */
  placeholderScriptUri: string;
  /** media/runner/alpine.min.js 的 asWebviewUri */
  alpineScriptUri: string;
  /** 顶栏显示的 gRPC server 地址 */
  server: string;
  /** 空态提示用的 proto 目录 */
  protoDir: string;
  /**
   * 当前作用域文件(0.3.86):非空 = 服务列表已收窄到该 proto 文件(点 CodeLens「▶ 调用」进入),
   * 顶栏据此渲染来源标识。内嵌进 boot 而不是等 host 补推 scope 消息:面板销毁后重开必走创建
   * 路径,不内嵌首帧会闪一下「无来源」再跳成「有来源」。
   */
  scopedFile?: string | null;
  /** runner.metadata 配置值:Headers 编辑器的初始行(0.3.35) */
  metadataDefault?: MetadataEntry[];
  /** 面板创建时已有缓存 services 可内嵌,避免闪烁;缺省走 loading 态等 postMessage */
  initialServices?: ServicesPayload;
}

export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** 内嵌 JSON 防 </script> 注入:`<` 转 <,JSON 语义不变。 */
export function escapeInlineJson(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json.replace(/</g, '\\u003c');
}

/** 复制 icon(codicon 风格双方框);服务名/方法名旁共用 */
const COPY_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>';

/** 回到顶部浮动按钮图标(0.3.67):向上箭头 */
const BACK_TOP_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3"/><path d="M3.5 7.5 8 3l4.5 4.5"/></svg>';

export function renderWorkbenchHtml(options: WorkbenchHtmlOptions): string {
  // 静态串 host 侧就地翻译;webview 内 Alpine 表达式求值的串经 boot.strings 下发,
  // webview 通过 $store.str.* / runner.js str() 读取({name} 占位符运行时替换)。
  const S = {
    title: l10n.t('RPC Workbench'),
    searchPlaceholder: l10n.t('Search services or methods...'),
    heading: l10n.t('RPC Services'),
    refresh: l10n.t('Refresh proto'),
    refreshing: l10n.t('Refreshing…'),
    loadingTitle: l10n.t('Parsing proto files…'),
    loadingDetail: l10n.t(
      'A parse is required on first launch or after proto changes; the page will refresh automatically when done.',
    ),
    errorCardTitle: l10n.t('Proto Load Errors'),
    noMatchTitle: l10n.t('No matching results'),
    noMatchHint: l10n.t('Try different keywords'),
    emptyTitle: l10n.t('No services found'),
    emptyDirPre: l10n.t('Add <code>.proto</code> files to'),
    emptyDirPost: l10n.t(', or set <code>protoUtils.runner.protoDir</code> to your proto directory in Settings'),
    emptyNoDir: l10n.t(
      'No workspace folder is open and no proto directory is configured. Open a folder with .proto files via "File → Open Folder", configure <code>protoUtils.runner.protoDir</code> in Settings (absolute paths work), or open a .proto file and click the ▶ Call lens above an rpc method. The lens works without configuration for self-contained files and same-directory imports; cross-directory import roots still require <code>protoUtils.runner.protoDir</code>.',
    ),
    // ---- 0.3.86 单文件作用域:顶栏来源标识 + 作用域态空态 ----
    // 都是静态串(直接进 markup,不经 Alpine 求值),故放 S 而非 boot.strings。
    scopeFrom: l10n.t('Source'),
    emptyScopedPre: l10n.t('No services are declared in'),
    emptyScopedPost: l10n.t(
      '. Only this file is in scope — click below to browse every service in the proto directory.',
    ),
    showAllServices: l10n.t('Show all services'),
    methodCountSuffix: l10n.t(' methods'),
    copiedBadge: l10n.t('✓ Copied'),
    responseTypeLabel: l10n.t('Response Type'),
    noFields: l10n.t('(no fields)'),
    optionalBadge: l10n.t('optional'),
    requiredBadge: l10n.t('required'),
    formTab: l10n.t('Form'),
    selectPlaceholder: l10n.t('-- Select --'),
    enumPlaceholder: l10n.t('Enum value'),
    bytesHint: l10n.t('Base64-encoded value'),
    noParams: l10n.t('(no parameters)'),
    send: l10n.t('Send'),
    sending: l10n.t('Sending...'),
    success: l10n.t('Success'),
    failed: l10n.t('Failed'),
    receiving: l10n.t('Receiving…'),
    cancelled: l10n.t('Cancelled'),
    done: l10n.t('Done'),
    expandAll: l10n.t('Expand all'),
    collapseAll: l10n.t('Collapse all'),
    // 0.3.70:原始 JSON/树切换、表单重置、全部收起服务
    resetForm: l10n.t('Reset'),
    collapseAllSvcs: l10n.t('Collapse all services'),
    cancel: l10n.t('Cancel'),
    // 0.3.75:顶栏服务器地址原地编辑提示
    serverEditHint: l10n.t('Click to edit server address'),
    headersTitle: l10n.t('Headers'),
    addHeader: l10n.t('Add header'),
    headerKeyPlaceholder: l10n.t('Header name'),
    headerValuePlaceholder: l10n.t('Header value'),
    respMetaTitle: l10n.t('Response metadata'),
    // ---- 调用序列(0.3.59,ADR-0012) ----
    servicesTab: l10n.t('Services'),
    sequenceTab: l10n.t('Sequence'),
    addToSequence: l10n.t('Add to sequence'),
    seqNamePlaceholder: l10n.t('Sequence name'),
    seqSave: l10n.t('Save'),
    seqRun: l10n.t('Run sequence'),
    seqRunning: l10n.t('Running…'),
    seqStop: l10n.t('Stop'),
    seqStopping: l10n.t('Stopping…'),
    seqEndStream: l10n.t('End & continue'),
    seqSavedTitle: l10n.t('Saved sequences'),
    seqLoad: l10n.t('Load'),
    seqDelete: l10n.t('Delete'),
    seqEmptySteps: l10n.t('No steps yet. Open a method and click Add to sequence.'),
    seqStepUp: l10n.t('Up'),
    seqStepDown: l10n.t('Down'),
    seqStepRemove: l10n.t('Remove'),
    seqReportTitle: l10n.t('Run report'),
    seqCopyReport: l10n.t('Copy report'),
    seqMethodMissing: l10n.t('Method not found. Click Refresh'),
    seqHeadersOverride: l10n.t('Headers overrides (same key wins over global)'),
    seqMaxMessages: l10n.t('Max messages'),
    seqStepsTab: l10n.t('Steps'),
    seqReportTab: l10n.t('Run report'),
    seqReportEmpty: l10n.t('Not run yet. Results appear here step by step after clicking Run sequence.'),
    // ---- 0.3.78:环境/历史/grpcurl/WKT/断言/client·bidi 流 ----
    envNone: l10n.t('No environment'),
    envSelectTitle: l10n.t('Active environment'),
    envEdit: l10n.t('Edit environments'),
    copyGrpcurl: l10n.t('Copy as grpcurl'),
    historyTitle: l10n.t('History'),
    historyRestore: l10n.t('Restore'),
    duplexOpen: l10n.t('Open stream'),
    duplexSend: l10n.t('Send message'),
    duplexHalfClose: l10n.t('End sending'),
    timestampNow: l10n.t('Now'),
    assertTitle: l10n.t('Assertions (failure aborts the sequence)'),
    addAssert: l10n.t('Add assertion'),
    assertPathPlaceholder: l10n.t('Path, e.g. data.id / count / durationMs'),
    assertExpectedPlaceholder: l10n.t('Expected value'),
    // 0.3.84:空态行动按钮
    openSettings: l10n.t('Open Settings'),
    goToServices: l10n.t('Go to Services'),
  };
  const strings = {
    copy: l10n.t('Copy'),
    copied: l10n.t('Copied'),
    // 0.3.73:Raw/折叠树切换按钮文案经 x-text 动态求值,必须走 boot.strings——
    // 放在静态 S 里 webview 取不到($store.str.rawTab = undefined),按钮渲染为空。
    rawTab: l10n.t('Raw JSON'),
    treeTab: l10n.t('Tree'),
    refreshed: l10n.t('Refreshed · {count} services'),
    refreshedErrors: l10n.t('Refreshed · {count} services · {errors} parse errors'),
    chunkCount: l10n.t('{count} messages'),
    ignored: l10n.t('Ignored: {fields}'),
    emptyLoadError: l10n.t('Unknown load error (empty message)'),
    respMetaHeader: l10n.t('header'),
    respMetaTrailer: l10n.t('trailer'),
    scopeClearHint: l10n.t(
      'Showing only the interfaces declared in this file (opened via the ▶ Call lens). Click to show every service in the proto directory.',
    ),
    prefillMiss: l10n.t('Call target not found: {service} · {method}. If you just added or renamed this rpc, save the .proto file first, then click Refresh.'),
    connUnreachable: l10n.t('Server unreachable'),
    svcUnavailable: l10n.t('Service unavailable — click Refresh to retry'),
    connRestored: l10n.t('Connection restored'),
    connLost: l10n.t('Connection lost'),
    // 0.3.64 服务页流收满上限的瞬时通知(0.3.70 修:曾误放在静态 S 里,webview 取不到 → toast 显示原始键名)
    streamCapReached: l10n.t('Reached {count} messages — auto-stopped'),
    // 调用序列动态通知(0.3.59):经 boot.strings 下发,runner.js str() 读取
    seqNameRequired: l10n.t('Enter a sequence name to save'),
    seqAdded: l10n.t('Added to sequence: {method}'),
    backTop: l10n.t('Back to top'),
    seqEmpty: l10n.t('Sequence has no steps'),
    seqLoadMiss: l10n.t('Sequence not found'),
    seqValidationFailed: l10n.t('{count} step(s) reference missing methods. Sequence not started.'),
    seqCompleted: l10n.t('Sequence completed'),
    seqAborted: l10n.t('Sequence aborted at a failed step'),
    seqStopped: l10n.t('Sequence stopped'),
    // 0.3.78 动态文案(runner.js STRING_DEFAULTS 同键英文兜底)
    envFileError: l10n.t('environments.json: {error}'),
    grpcurlCopied: l10n.t('grpcurl command copied'),
    grpcurlFailed: l10n.t('Copy as grpcurl failed: {error}'),
    historyRestored: l10n.t('Restored from history'),
    duplexSent: l10n.t('{count} sent'),
    assertActual: l10n.t('actual: {value}'),
    wktTimestamp: l10n.t('RFC 3339, e.g. 2024-01-01T00:00:00Z'),
    wktDuration: l10n.t('e.g. 1.5s'),
    wktBool: l10n.t('true / false'),
    wktValue: l10n.t('Value (empty = unset)'),
    // 0.3.81 序列报告折叠树批量按钮(x-text 动态求值)
    expandAll: l10n.t('Expand all'),
    collapseAll: l10n.t('Collapse all'),
    // 0.3.84 动态文案:标题随视图切换、状态点 tooltip、加入序列禁用原因
    headingServices: l10n.t('RPC Services'),
    headingSequence: l10n.t('Call Sequence'),
    connOk: l10n.t('Server reachable'),
    connProbing: l10n.t('Checking connection…'),
    seqAddStreamUnsupported: l10n.t('Client/bidi streaming methods cannot join a sequence'),
    // 0.3.84:seqAddTitle() 运行时读取(禁用态 tooltip 需要正常态文案作对照)
    addToSequence: l10n.t('Add to sequence'),
  };
  const boot = {
    server: options.server,
    protoDir: options.protoDir,
    scopedFile: options.scopedFile ?? null,
    metadata: options.metadataDefault ?? [],
    services: options.initialServices ?? null,
    strings,
  };
  const csp = [
    `default-src 'none'`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${env.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${options.stylesUri}">
  <title>${S.title}</title>
  <script nonce="${options.nonce}">window.__PROTO_UTILS_BOOT__ = ${escapeInlineJson(boot)};</script>
  <script nonce="${options.nonce}" src="${options.formMappingScriptUri}"></script>
  <script nonce="${options.nonce}" src="${options.resultTreeScriptUri}"></script>
  <script nonce="${options.nonce}" src="${options.placeholderScriptUri}"></script>
  <script nonce="${options.nonce}" src="${options.runnerScriptUri}"></script>
  <script nonce="${options.nonce}" defer src="${options.alpineScriptUri}"></script>
</head>
<body>
  <!-- 0.3.84:顶栏只承载搜索;序列视图下整条隐藏(此前残留 48px 空白带) -->
  <div class="topbar" x-data x-cloak x-show="$store.workbench.view === 'services'">
    <div class="topbar-search" x-data x-cloak x-show="$store.workbench.view === 'services'">
      <input
        type="search"
        x-model="$store.search.query"
        placeholder="${S.searchPlaceholder}"
        autocomplete="off"
      >
    </div>
  </div>
  <div class="container" x-data="homePage" x-cloak>
    <div class="page-header">
      <!-- 0.3.84:标题随视图切换(此前序列视图仍写「RPC Services」) -->
      <h1 class="page-title" x-text="headingText()">${S.heading}</h1>

      <div class="view-tabs">
        <button type="button" class="view-tab" :class="{ 'view-tab-active': $store.workbench.view === 'services' }" @click="setView('services')">${S.servicesTab}</button>
        <button type="button" class="view-tab" :class="{ 'view-tab-active': $store.workbench.view === 'sequence' }" @click="setView('sequence')">${S.sequenceTab}</button>
      </div>

      <div class="page-meta" x-data="pageMeta" x-cloak>
        <!-- 0.3.54:状态点绑定真实连通性(connState 由 host 探测推送;unknown=灰/ok=绿/fail=红) -->
        <!-- 0.3.84:状态点补 tooltip(三态语义此前全靠一个 7px 圆点传达) -->
        <!-- 0.3.75:地址可点击原地编辑(Enter/失焦确认、Esc 取消),确认经 setServer 消息持久化;赋值全走组件方法(@alpinejs/csp) -->
        <span><span class="dot" :class="$store.workbench.connState" :title="connTitle()"></span><span class="server-addr" role="button" tabindex="0" title="${S.serverEditHint}" x-show="!editingServer" x-text="$store.workbench.server" @click="startEditServer()" @keydown.enter="startEditServer()"></span><input class="server-edit" type="text" spellcheck="false" autocomplete="off" x-show="editingServer" x-ref="serverInput" x-model="serverDraft" @keydown.enter="commitEditServer()" @keydown.escape="cancelEditServer()" @blur="commitEditServer()"><span class="conn-hint" x-show="$store.workbench.connState === 'fail'" x-text="$store.str.connUnreachable"></span></span>
        <!-- 0.3.86:接口来源标识。作用域态(点 CodeLens「▶ 调用」进入)才显示,点击解除收窄回到
             protoDir 全量。用原生 button 而非 role=button 的 span:键盘可达性由浏览器负责,
             不必像 0.3.84 那批折叠热区一样手补 tabindex 与 Enter/Space。样式全在 runner.css。
             clearScope/scopeFileName 定义在 homePage 上,靠 Alpine 的向上作用域链解析到——
             与同一 page-meta 里的 collapseAllServices() 一个路子。 -->
        <button type="button" class="btn btn-secondary btn-xs scope-chip" x-show="$store.workbench.scopedFile" :title="scopeClearTitle()" @click="clearScope()">
          <span class="scope-chip-label">${S.scopeFrom}</span>
          <span class="scope-chip-file" x-text="scopeFileName()"></span>
          <span class="scope-chip-x" aria-hidden="true">&times;</span>
        </button>
        <!-- 0.3.78 环境切换:无工作区时宿主不推快照,整块隐藏;地址含 {{var}} 时旁显替换结果 -->
        <span class="env-picker" x-show="$store.workbench.envSupported">
          <span class="server-resolved" x-show="resolvedServerText()" x-text="resolvedServerText()"></span>
          <select class="env-select" title="${S.envSelectTitle}" @change="setEnvironment($event.target.value)">
            <option value="" :selected="!$store.workbench.envActive">${S.envNone}</option>
            <template x-for="n in $store.workbench.envNames" :key="n">
              <option :value="n" :selected="$store.workbench.envActive === n" x-text="n"></option>
            </template>
          </select>
          <button type="button" class="btn btn-secondary btn-xs" @click="editEnvironments()">${S.envEdit}</button>
          <span class="env-error" x-show="envErrorText()" x-text="envErrorText()"></span>
        </span>
        <!-- 0.3.76 刷新服务按钮移除:探测由打开首探/编辑地址后静默探/周期复探三路覆盖;「刷新 proto」保留 invalidate+重解析 -->
        <button type="button" class="btn btn-secondary btn-xs" :disabled="$store.workbench.refreshing" @click="refresh()">
          <span x-show="!$store.workbench.refreshing">${S.refresh}</span>
          <span x-show="$store.workbench.refreshing"><span class="proto-loading-spinner"></span>${S.refreshing}</span>
        </button>
        <!-- 0.3.70:全部收起服务卡片(大工作区逐个收太慢);0.3.84:序列视图无服务卡片,按钮一并隐藏 -->
        <button type="button" class="btn btn-secondary btn-xs" x-show="$store.workbench.view === 'services' && $store.workbench.services.length > 1" @click="collapseAllServices()">${S.collapseAllSvcs}</button>
        <span class="refresh-notice" :class="'refresh-notice-' + $store.workbench.refreshNoticeKind" role="status" aria-live="polite" x-show="$store.workbench.refreshNotice" x-text="$store.workbench.refreshNotice" x-transition.opacity></span>
      </div>
    </div>

    <div class="card" id="proto-loading-card" x-show="$store.workbench.state === 'loading'">
      <div class="card-title"><span><span class="proto-loading-spinner"></span>${S.loadingTitle}</span></div>
      <p id="proto-loading-detail" class="proto-loading-detail">${S.loadingDetail}</p>
    </div>

    <div class="card error-card" id="proto-error-card" x-show="$store.workbench.errors.length > 0">
      <div class="card-title">${S.errorCardTitle}</div>
      <template x-for="(e, eIdx) in $store.workbench.errors" :key="eIdx">
        <!-- 0.3.40:出错点分段渲染,spot 段红色波浪线(仿编辑器飘红);x-text 结构化转义,无注入面 -->
        <p class="error-line"><template x-for="(seg, sIdx) in $store.workbench.errorSegs[eIdx]" :key="sIdx"><span x-text="seg.text" :class="{ 'error-spot': seg.spot }"></span></template></p>
      </template>
    </div>

    <!-- 0.3.45:CodeLens prefill 落空的可见反馈(改名未保存/列表未就绪),替代此前的零反馈 -->
    <div class="card error-card" id="prefill-miss-card" x-show="$store.workbench.prefillNotice">
      <p class="error-line" x-text="$store.workbench.prefillNotice"></p>
    </div>

    <div x-show="$store.workbench.view === 'services'">
    <div x-show="$store.workbench.state === 'ready' && filteredServices().length === 0 && query.trim()" class="empty-state">
      <h2 style="font-size:16px">${S.noMatchTitle}</h2>
      <p>${S.noMatchHint}</p>
    </div>

    <div class="empty-state" x-show="$store.workbench.state === 'ready' && $store.workbench.services.length === 0 && !query.trim()">
      <h2 style="font-size:16px">${S.emptyTitle}</h2>
      <!-- 0.3.86:三分支互斥。作用域态下列表为空 = 该文件没声明 service,与 protoDir 配得
           好不好毫无关系;沿用旧文案会让人去改一个根本不相干的设置。 -->
      <p x-show="$store.workbench.scopedFile">${S.emptyScopedPre} <code x-text="scopeFileName()" :title="$store.workbench.scopedFile"></code>${S.emptyScopedPost}</p>
      <button type="button" class="btn btn-secondary" x-show="$store.workbench.scopedFile" @click="clearScope()">${S.showAllServices}</button>
      <p x-show="!$store.workbench.scopedFile && $store.workbench.protoDir">${S.emptyDirPre} <code x-text="$store.workbench.protoDir"></code>${S.emptyDirPost}</p>
      <p x-show="!$store.workbench.scopedFile && !$store.workbench.protoDir">${S.emptyNoDir}</p>
      <!-- 0.3.84:空态给行动出口,不再只有一段说明文字 -->
      <button type="button" class="btn btn-secondary" x-show="!$store.workbench.scopedFile && !$store.workbench.protoDir" @click="openSettings()">${S.openSettings}</button>
    </div>

    <template x-for="svc in filteredServices()" :key="svcId(svc)">
      <div class="card service-card">
        <!-- 0.3.84:折叠热区补键盘可达(role/tabindex/aria-expanded + Enter/Space) -->
        <div
          class="card-title card-title-toggle"
          role="button"
          tabindex="0"
          :aria-expanded="isServiceOpen(svcId(svc))"
          @click="toggleService(svcId(svc))"
          @keydown.enter.prevent="toggleService(svcId(svc))"
          @keydown.space.prevent="toggleService(svcId(svc))"
        >
          <span>
            <!-- 0.3.70:搜索命中高亮(子串整段/模糊按序) -->
            <template x-for="(seg, segIdx) in nameSegments(svc.name, query)" :key="segIdx"><span x-text="seg.text" :class="{ 'search-hit': seg.hit }"></span></template>
            <span
              class="copy-icon"
              role="button"
              :title="$store.str.copy"
              x-show="!isServiceCopied(svc)"
              @click.stop="copyServiceName(svc)"
            >${COPY_ICON_SVG}</span>
            <span x-show="isServiceCopied(svc)" class="copy-badge">${S.copiedBadge}</span>
            <span style="font-weight:400;text-transform:none;color:var(--text-faint)">
              — <span x-text="filteredMethods(svc).length"></span>${S.methodCountSuffix}
            </span>
          </span>
          <span class="collapse-icon" x-text="isServiceOpen(svcId(svc)) ? '▼' : '▶'"></span>
        </div>
        <div x-show="isServiceOpen(svcId(svc))">
          <template x-for="m in filteredMethods(svc)" :key="m.name">
            <div class="method-block">
              <div
                class="method-row"
                :id="'method-' + svcId(svc) + '-' + m.name"
                :class="{ 'method-row-active': isMethodOpen(svcId(svc), m.name) }"
                @click="toggleMethod(svcId(svc), m.name, m)"
              >
                <!-- 0.3.84:整行可点;方法名是键盘可达的语义控件(.stop 防与行点击双触发) -->
                <span
                  class="method-name"
                  role="button"
                  tabindex="0"
                  :aria-expanded="isMethodOpen(svcId(svc), m.name)"
                  @click.stop="toggleMethod(svcId(svc), m.name, m)"
                  @keydown.enter.prevent.stop="toggleMethod(svcId(svc), m.name, m)"
                  @keydown.space.prevent.stop="toggleMethod(svcId(svc), m.name, m)"
                >
                  <!-- 0.3.70:搜索命中高亮 -->
                  <template x-for="(seg, segIdx) in nameSegments(m.name, query)" :key="segIdx"><span x-text="seg.text" :class="{ 'search-hit': seg.hit }"></span></template>
                  <span
                    class="copy-icon"
                    role="button"
                    :title="$store.str.copy"
                    x-show="!isMethodCopied(svcId(svc), m.name)"
                    @click.stop="copyMethodName(svcId(svc), m.name)"
                  >${COPY_ICON_SVG}</span>
                  <span x-show="isMethodCopied(svcId(svc), m.name)" class="copy-badge">${S.copiedBadge}</span>
                </span>
                <span x-show="m.responseStream && !m.requestStream" class="method-stream-badge">stream</span>
                <span x-show="m.requestStream" class="method-stream-badge" x-text="m.responseStream ? 'bidi' : 'client stream'"></span>
                <button
                  type="button"
                  class="btn btn-secondary btn-xs seq-add"
                  :disabled="m.requestStream"
                  :title="seqAddTitle(m)"
                  @click.stop="addToSequence(svc, m)"
                >+ ${S.addToSequence}</button>
                <span class="collapse-icon" x-text="isMethodOpen(svcId(svc), m.name) ? '▼' : '▶'"></span>
              </div>
              <template x-if="isMethodOpen(svcId(svc), m.name)">
                <div class="method-panel" @click.stop>
                  <!-- 0.3.84:Headers 改默认折叠(与响应 metadata 同款折叠块 + 计数徽章),
                       无自定义行时不再占方法面板首屏 -->
                  <div class="resp-meta headers-block">
                    <div
                      class="resp-meta-toggle"
                      role="button"
                      tabindex="0"
                      :aria-expanded="isHeadersOpen(methodKey(svcId(svc), m.name))"
                      @click="toggleHeaders(methodKey(svcId(svc), m.name))"
                      @keydown.enter.prevent="toggleHeaders(methodKey(svcId(svc), m.name))"
                      @keydown.space.prevent="toggleHeaders(methodKey(svcId(svc), m.name))"
                    >
                      <span class="collapse-icon" x-text="isHeadersOpen(methodKey(svcId(svc), m.name)) ? '▼' : '▶'"></span>
                      <span>${S.headersTitle}</span>
                      <span class="resp-meta-count" x-text="getHeaders(methodKey(svcId(svc), m.name)).length"></span>
                    </div>
                    <div x-show="isHeadersOpen(methodKey(svcId(svc), m.name))" class="resp-meta-body">
                    <div class="headers-editor">
                      <div class="headers-editor-head">
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs"
                          @click="addHeaderRow(methodKey(svcId(svc), m.name))"
                        >${S.addHeader}</button>
                      </div>
                    <template x-for="(h, hIdx) in getHeaders(methodKey(svcId(svc), m.name))" :key="hIdx">
                      <div class="header-row">
                        <input
                          type="text"
                          class="header-key"
                          :value="h.key"
                          @input="setHeaderField(methodKey(svcId(svc), m.name), hIdx, 'key', $event.target.value)"
                          placeholder="${S.headerKeyPlaceholder}"
                          autocomplete="off"
                        >
                        <input
                          type="text"
                          class="header-value"
                          :value="h.value"
                          @input="setHeaderField(methodKey(svcId(svc), m.name), hIdx, 'value', $event.target.value)"
                          placeholder="${S.headerValuePlaceholder}"
                          autocomplete="off"
                        >
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs header-remove"
                          @click="removeHeaderRow(methodKey(svcId(svc), m.name), hIdx)"
                        >×</button>
                      </div>
                    </template>
                  </div>
                    </div>
                  </div>
                  <!-- 0.3.78 请求历史:按 service+method 过滤,点「恢复」回填入参与 headers -->
                  <div class="resp-meta history-block" x-show="historyFor(svcId(svc), m.name).length > 0">
                    <div
                      class="resp-meta-toggle"
                      role="button"
                      tabindex="0"
                      :aria-expanded="isHistoryOpen(methodKey(svcId(svc), m.name))"
                      @click="toggleHistory(methodKey(svcId(svc), m.name))"
                      @keydown.enter.prevent="toggleHistory(methodKey(svcId(svc), m.name))"
                      @keydown.space.prevent="toggleHistory(methodKey(svcId(svc), m.name))"
                    >
                      <span class="collapse-icon" x-text="isHistoryOpen(methodKey(svcId(svc), m.name)) ? '▼' : '▶'"></span>
                      <span>${S.historyTitle}</span>
                      <span class="resp-meta-count" x-text="historyFor(svcId(svc), m.name).length"></span>
                    </div>
                    <div x-show="isHistoryOpen(methodKey(svcId(svc), m.name))" class="resp-meta-body">
                      <template x-for="(he, heIdx) in historyFor(svcId(svc), m.name)" :key="he.ts + '-' + heIdx">
                        <div class="history-row">
                          <span :class="he.ok ? 'result-ok' : 'result-err'" x-text="he.ok ? '✓' : '✗'"></span>
                          <span class="history-time" x-text="historyLabel(he)"></span>
                          <button type="button" class="btn btn-secondary btn-xs" @click="restoreHistory(svcId(svc), m.name, m, he)">${S.historyRestore}</button>
                        </div>
                      </template>
                    </div>
                  </div>
                  <div class="method-schema">
                    <div class="method-schema-block">
                      <!-- 0.3.53:返回类型默认折叠,点标题行展开(resblk 作用域键,expandedRows 缺省即折叠) -->
                      <div
                        class="method-type-row method-type-row-toggle"
                        role="button"
                        tabindex="0"
                        :aria-expanded="isRowOpen(rowKey('resblk', methodKey(svcId(svc), m.name)))"
                        @click.stop="toggleRow(rowKey('resblk', methodKey(svcId(svc), m.name)))"
                        @keydown.enter.prevent.stop="toggleRow(rowKey('resblk', methodKey(svcId(svc), m.name)))"
                        @keydown.space.prevent.stop="toggleRow(rowKey('resblk', methodKey(svcId(svc), m.name)))"
                      >
                        <span
                          class="collapse-icon"
                          x-text="isRowOpen(rowKey('resblk', methodKey(svcId(svc), m.name))) ? '▼' : '▶'"
                        ></span>
                        <span class="method-type-label">${S.responseTypeLabel}</span>
                        <span class="method-type-name" x-text="m.responseType"></span>
                      </div>
                      <div x-show="isRowOpen(rowKey('resblk', methodKey(svcId(svc), m.name)))">
                      <div x-show="!(m.responseSchemaRows && m.responseSchemaRows.length)" class="method-fields-empty">${S.noFields}</div>
                      <template x-for="(row, rowIdx) in visibleSchemaRows(m.responseSchemaRows, 'res')" :key="m.name + '-res-' + rowIdx">
                        <div>
                          <div
                            class="method-field-row"
                            :class="{ 'method-field-row-expandable': (row.children && row.children.length) || (row.enumValues && row.enumValues.length) }"
                            :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                            @click.stop="(row.children && row.children.length) || (row.enumValues && row.enumValues.length) ? toggleRow(rowKey('res', row.path)) : null"
                          >
                            <span class="method-field-name" x-text="row.name"></span>
                            <span class="method-field-meta">
                              <span class="field-type-badge" x-text="row.typeLabel"></span>
                              <span x-show="row.optional" class="field-optional-badge">${S.optionalBadge}</span>
                              <span x-show="row.comment" class="field-comment" x-text="row.comment"></span>
                              <span
                                x-show="(row.children && row.children.length) || (row.enumValues && row.enumValues.length)"
                                class="collapse-icon"
                                x-text="isRowOpen(rowKey('res', row.path)) ? '▼' : '▶'"
                              ></span>
                            </span>
                          </div>
                          <!-- 可见性折进 :style 三元式而非 x-show:二者同元素时,:style 字符串重赋值
                               会整体替换 inline style,抹掉 x-show 写入的 display:none(services
                               重推后 x-for 重建行即触发,残留空白行,0.3.47 修复) -->
                          <div
                            class="enum-values-list"
                            :style="(row.enumValues && row.enumValues.length && isRowOpen(rowKey('res', row.path))) ? 'padding-left:' + (row.depth * 14 + 24) + 'px' : 'display: none'"
                          >
                            <template x-for="ev in row.enumValues" :key="ev.name">
                              <div class="enum-value-item" x-text="enumOptionLabel(ev, row.enumValues)"></div>
                            </template>
                          </div>
                        </div>
                      </template>
                      </div>
                    </div>
                  </div>
                  <form class="form-section" @submit.prevent="sendFromEditor(svcId(svc), m.name, m)">
                      <div class="editor-tabs" x-show="m.requestFields.length > 0">
                        <span class="editor-tabs-group">
                          <button
                            type="button"
                            class="editor-tab"
                            :class="{ 'editor-tab-active': getEditorMode(methodKey(svcId(svc), m.name)) === 'form' }"
                            @click="setEditorMode(methodKey(svcId(svc), m.name), 'form', m)"
                          >${S.formTab}</button>
                          <button
                            type="button"
                            class="editor-tab"
                            :class="{ 'editor-tab-active': getEditorMode(methodKey(svcId(svc), m.name)) === 'json' }"
                            @click="setEditorMode(methodKey(svcId(svc), m.name), 'json', m)"
                          >JSON</button>
                        </span>
                        <!-- 0.3.71:重置移到 表单/JSON 同一行右侧(此前在底部发送按钮旁,长表单要滚到底) -->
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs"
                          :disabled="isLoading(svcId(svc), m.name)"
                          @click="resetForm(methodKey(svcId(svc), m.name), m)"
                        >${S.resetForm}</button>
                      </div>
                    <div x-show="showFormPane(methodKey(svcId(svc), m.name), m)">
                    <template x-for="(row, reqIdx) in flattenFormFields(m.requestFields)" :key="m.name + '-req-' + reqIdx">
                      <div>
                        <!-- 同上:kind 门控折进 :style,避免 x-show 与 :style 同元素的 display 抹除 -->
                        <div
                          class="field-group"
                          :style="row.kind === 'group' ? 'padding-left:' + (row.depth * 14) + 'px' : 'display: none'"
                        >
                          <span class="field-group-name" x-text="row.field.name"></span>
                          <span class="field-type-badge" x-text="row.field.refType || 'message'"></span>
                        </div>
                        <div
                          class="field"
                          :style="row.kind === 'input' ? 'padding-left:' + (row.depth * 14 + 8) + 'px' : 'display: none'"
                        >
                          <label class="field-label">
                            <span x-text="row.field.name"></span>
                            <span class="field-type-badge">
                              <span x-text="fieldTypeLabel(row.field)"></span>
                            </span>
                            <span x-show="row.field.optional" class="field-optional-badge">${S.optionalBadge}</span>
                            <span x-show="row.field.required" class="field-required-badge">${S.requiredBadge}</span>
                            <span x-show="row.field.comment" class="field-comment" x-text="row.field.comment"></span>
                            <span
                              x-show="(row.field.nestedFields && row.field.nestedFields.length) || (row.field.enumValues && row.field.enumValues.length)"
                              class="collapse-icon"
                              @click.stop="toggleRow(rowKey('reqf', row.path))"
                              x-text="isRowOpen(rowKey('reqf', row.path)) ? '▼' : '▶'"
                            ></span>
                          </label>
                          <div
                            class="method-schema-block"
                            :style="(isRowOpen(rowKey('reqf', row.path)) && ((row.field.nestedFields && row.field.nestedFields.length) || (row.field.enumValues && row.field.enumValues.length))) ? 'margin-bottom: 10px; padding-left:' + (row.depth * 14 + 24) + 'px' : 'display: none'"
                          >
                            <div
                              x-show="row.field.protoType === 'TYPE_ENUM' && (row.field.enumValues && row.field.enumValues.length)"
                              class="enum-values-list"
                            >
                              <template x-for="ev in row.field.enumValues" :key="ev.name">
                                <div class="enum-value-item" x-text="enumOptionLabel(ev, row.field.enumValues)"></div>
                              </template>
                            </div>
                            <div x-show="row.field.protoType === 'TYPE_MESSAGE' && (row.field.nestedFields && row.field.nestedFields.length)">
                              <template x-for="(sRow, sIdx) in visibleSchemaRows(fieldSchemaRows(row.field), 'reqs')" :key="m.name + '-reqs-' + sIdx">
                                <div>
                                  <div
                                    class="method-field-row"
                                    :class="{ 'method-field-row-expandable': (sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length) }"
                                    :style="'padding-left:' + (sRow.depth * 14 + 8) + 'px'"
                                    @click.stop="(sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length) ? toggleRow(rowKey('reqs', sRow.path)) : null"
                                  >
                                    <span class="method-field-name" x-text="sRow.name"></span>
                                    <span class="method-field-meta">
                                      <span class="field-type-badge" x-text="sRow.typeLabel"></span>
                                      <span x-show="sRow.optional" class="field-optional-badge">${S.optionalBadge}</span>
                                      <span x-show="sRow.comment" class="field-comment" x-text="sRow.comment"></span>
                                      <span
                                        x-show="(sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length)"
                                        class="collapse-icon"
                                        x-text="isRowOpen(rowKey('reqs', sRow.path)) ? '▼' : '▶'"
                                      ></span>
                                    </span>
                                  </div>
                                  <div
                                    class="enum-values-list"
                                    :style="(sRow.enumValues && sRow.enumValues.length && isRowOpen(rowKey('reqs', sRow.path))) ? 'padding-left:' + (sRow.depth * 14 + 24) + 'px' : 'display: none'"
                                  >
                                    <template x-for="ev in sRow.enumValues" :key="ev.name">
                                      <div class="enum-value-item" x-text="enumOptionLabel(ev, sRow.enumValues)"></div>
                                    </template>
                                  </div>
                                </div>
                              </template>
                            </div>
                          </div>
                          <template x-if="row.field.protoType === 'TYPE_BOOL'">
                            <input
                              type="checkbox"
                              :checked="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @change="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.checked)"
                            >
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_ENUM' && row.field.enumValues && row.field.enumValues.length > 0">
                            <select
                              class="enum-select"
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @change="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                            >
                              <option value="">${S.selectPlaceholder}</option>
                              <template x-for="ev in row.field.enumValues" :key="ev.name">
                                <option :value="ev.name" x-text="enumOptionLabel(ev, row.field.enumValues)"></option>
                              </template>
                            </select>
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_ENUM' && (!row.field.enumValues || row.field.enumValues.length === 0)">
                            <input
                              type="text"
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                              placeholder="${S.enumPlaceholder}"
                            >
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_MESSAGE' && !row.wkt">
                            <textarea
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                              :placeholder="messagePlaceholder(row.field)"
                            ></textarea>
                          </template>
                          <!-- 0.3.78 Timestamp/Duration/wrappers:单行文本,Timestamp 附「现在」一键填入 -->
                          <template x-if="row.wkt">
                            <span class="wkt-input">
                              <input
                                type="text"
                                :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                                @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                                :placeholder="wktPlaceholder(row.wkt)"
                              >
                              <button type="button" class="btn btn-secondary btn-xs" x-show="row.wkt === 'Timestamp'" @click="setTimestampNow(methodKey(svcId(svc), m.name), row.path)">${S.timestampNow}</button>
                            </span>
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_BYTES'">
                            <input
                              type="text"
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                              placeholder="${S.bytesHint}"
                              title="${S.bytesHint}"
                            >
                          </template>
                          <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.protoType !== 'TYPE_BYTES' && row.field.type === 'number'">
                            <input
                              type="number"
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                            >
                          </template>
                          <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.protoType !== 'TYPE_BYTES' && row.field.type !== 'number'">
                            <input
                              type="text"
                              :value="getFieldValue(methodKey(svcId(svc), m.name), row.path)"
                              @input="setFieldValue(methodKey(svcId(svc), m.name), row.path, $event.target.value)"
                            >
                          </template>
                        </div>
                      </div>
                    </template>
                    </div>
                    <div x-show="m.requestFields.length === 0" class="method-fields-empty">${S.noParams}</div>
                    <div x-show="showJsonPane(methodKey(svcId(svc), m.name), m)">
                      <textarea
                        class="json-editor"
                        spellcheck="false"
                        placeholder='{ "fileId": 1 }'
                        :value="getJsonText(methodKey(svcId(svc), m.name))"
                        @input="onJsonInput(methodKey(svcId(svc), m.name), $event.target.value)"
                      ></textarea>
                      <div
                        x-show="getJsonError(methodKey(svcId(svc), m.name))"
                        class="json-error"
                        x-text="getJsonError(methodKey(svcId(svc), m.name))"
                      ></div>
                    </div>
                    <div
                      x-show="hasJsonWarnings(methodKey(svcId(svc), m.name))"
                      class="json-warning"
                      x-text="jsonWarningText(methodKey(svcId(svc), m.name))"
                    ></div>

                    <!-- 0.3.44:表单模式发送前校验的问题清单;两个页签共用同一展示槽 -->
                    <div
                      x-show="getFormError(methodKey(svcId(svc), m.name))"
                      class="json-error"
                      x-text="getFormError(methodKey(svcId(svc), m.name))"
                    ></div>

                    <!-- 0.3.64 服务页流方法接收上限:收满自动停并按「完成」展示;空 = 100,0 = 不限 -->
                    <div class="seq-maxmsgs" x-show="m.responseStream">
                      <span class="seq-maxmsgs-label">${S.seqMaxMessages}</span>
                      <input
                        type="number"
                        min="0"
                        class="seq-maxmsgs-input"
                        :value="seqMaxMsgs[methodKey(svcId(svc), m.name)] || ''"
                        @input="setSeqMaxMsgs(methodKey(svcId(svc), m.name), $event.target.value)"
                        placeholder="100"
                      >
                    </div>

                      <div>
                      <button
                        type="button"
                        class="btn"
                        x-show="!m.requestStream"
                        :disabled="isLoading(svcId(svc), m.name) || m.requestStream || $store.workbench.connState === 'fail'"
                        @click="sendFromEditor(svcId(svc), m.name, m)"
                      >
                        <span x-show="!isLoading(svcId(svc), m.name)">${S.send}</span>
                        <span x-show="isLoading(svcId(svc), m.name)">${S.sending}</span>
                      </button>
                      <!-- 0.3.78(ADR-0013):client/bidi 流会话——打开 → 逐条发送当前表单 → 结束发送;取消在结果区 -->
                      <template x-if="m.requestStream">
                        <span class="duplex-controls">
                          <button type="button" class="btn" :disabled="streamIsLive(svcId(svc), m.name) || $store.workbench.connState === 'fail'" @click="openDuplex(svcId(svc), m.name)">${S.duplexOpen}</button>
                          <button type="button" class="btn btn-secondary" :disabled="!duplexCanSend(svcId(svc), m.name)" @click="sendFromEditor(svcId(svc), m.name, m)">${S.duplexSend}</button>
                          <button type="button" class="btn btn-secondary" :disabled="!duplexCanSend(svcId(svc), m.name)" @click="halfCloseDuplex(svcId(svc), m.name)">${S.duplexHalfClose}</button>
                          <span class="elapsed-hint" x-text="duplexSentText(svcId(svc), m.name)"></span>
                        </span>
                      </template>
                      <button type="button" class="btn btn-secondary" @click="copyGrpcurl(svcId(svc), m.name, m)">${S.copyGrpcurl}</button>
                      <!-- 0.3.70:在途实时计时(重置按钮已移至上方 表单/JSON 行右侧) -->
                      <span class="elapsed-hint" x-show="isLoading(svcId(svc), m.name)" x-text="elapsedText(methodKey(svcId(svc), m.name))"></span>
                      <!-- 0.3.54:探测不可达时禁发并就地提示;unknown(探测中)不拦,可达服务不吃 1.5s 探测闪断 -->
                      <p x-show="$store.workbench.connState === 'fail'" class="unsupported-hint" x-text="$store.str.svcUnavailable"></p>
                    </div>
                  </form>

                  <template x-if="!m.responseStream && !m.requestStream">
                    <div
                      x-show="getResult(svcId(svc), m.name)"
                      class="result-section"
                    >
                      <div class="result-header">
                        <div class="result-meta">
                          <span
                            x-show="resultStatusIs(svcId(svc), m.name, 'ok')"
                            class="result-ok"
                          >${S.success}</span>
                          <span
                            x-show="resultStatusIsNot(svcId(svc), m.name, 'ok')"
                            class="result-err"
                          >${S.failed}</span>
                          <span class="result-time" x-text="resultDurationText(svcId(svc), m.name)"></span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          x-show="resultTreeAvailable(svcId(svc), m.name)"
                          @click="expandAllResult(svcId(svc), m.name)"
                        >${S.expandAll}</button>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          x-show="resultTreeAvailable(svcId(svc), m.name)"
                          @click="collapseAllResult(svcId(svc), m.name)"
                        >${S.collapseAll}</button>
                        <!-- 0.3.70:原始 JSON / 折叠树切换(树可见时才出现) -->
                        <button
                          type="button"
                          class="btn btn-secondary"
                          x-show="resultTreeAvailable(svcId(svc), m.name)"
                          @click="toggleRaw(methodKey(svcId(svc), m.name))"
                          x-text="isRawOpen(methodKey(svcId(svc), m.name)) ? $store.str.treeTab : $store.str.rawTab"
                        ></button>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          @click="copyResult(svcId(svc), m.name)"
                          x-text="isCopied(svcId(svc), m.name) ? $store.str.copied : $store.str.copy"
                        ></button>
                      </div>
                      <div class="resp-meta" x-show="hasRespMeta(svcId(svc), m.name)">
                        <div
                          class="resp-meta-toggle"
                          role="button"
                          tabindex="0"
                          :aria-expanded="isRespMetaOpen(svcId(svc), m.name)"
                          @click="toggleRespMeta(svcId(svc), m.name)"
                          @keydown.enter.prevent="toggleRespMeta(svcId(svc), m.name)"
                          @keydown.space.prevent="toggleRespMeta(svcId(svc), m.name)"
                        >
                          <span class="collapse-icon" x-text="isRespMetaOpen(svcId(svc), m.name) ? '▼' : '▶'"></span>
                          <span>${S.respMetaTitle}</span>
                          <span class="resp-meta-count" x-text="respMetaCountText(svcId(svc), m.name)"></span>
                        </div>
                        <div x-show="isRespMetaOpen(svcId(svc), m.name)" class="resp-meta-body">
                          <template x-for="(entry, eIdx) in respMetaEntries(svcId(svc), m.name)" :key="eIdx">
                            <div class="resp-meta-row">
                              <span class="resp-meta-source" x-text="entry.source"></span>
                              <span class="resp-meta-key" x-text="entry.key"></span>
                              <span class="resp-meta-value" x-text="entry.value"></span>
                            </div>
                          </template>
                        </div>
                      </div>
                      <!-- 0.3.41:响应数据 DevTools 风格折叠树;错误/缺 data 退化为原始 <pre>。0.3.70:Raw 开关可强制看原始 JSON -->
                      <div x-show="resultTreeAvailable(svcId(svc), m.name) && !isRawOpen(methodKey(svcId(svc), m.name))" class="result-body result-tree">
                        <template x-for="row in resultTreeRows(svcId(svc), m.name)" :key="row.path">
                          <div
                            class="tree-row"
                            :class="{ 'tree-row-container': row.children && row.children.length }"
                            :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                            @click.stop="row.children && row.children.length ? toggleTreeNode(svcId(svc), m.name, row.path) : null"
                          >
                            <span x-show="row.children && row.children.length" class="collapse-icon" x-text="isTreeNodeOpen(svcId(svc), m.name, row.path) ? '▼' : '▶'"></span>
                            <span x-show="!(row.children && row.children.length)" class="tree-spacer"></span>
                            <span x-show="row.key" class="tree-key" x-text="row.key"></span>
                            <span x-show="row.key" class="tree-colon">:</span>
                            <span class="tree-value" :class="'tree-value-' + row.kind" x-text="row.value"></span>
                            <span x-show="row.count" class="tree-count" x-text="row.count"></span>
                          </div>
                        </template>
                      </div>
                      <pre x-show="!resultTreeAvailable(svcId(svc), m.name) || isRawOpen(methodKey(svcId(svc), m.name))" class="result-body" x-text="resultBodyText(svcId(svc), m.name)"></pre>
                    </div>
                  </template>

                  <template x-if="m.responseStream || m.requestStream">
                    <div
                      x-show="getStream(svcId(svc), m.name) || getResult(svcId(svc), m.name)"
                      class="result-section"
                    >
                      <div class="result-header">
                        <div class="result-meta">
                          <template x-if="resultStatusIs(svcId(svc), m.name, 'error')">
                            <span class="result-err">${S.failed}</span>
                          </template>
                          <template x-if="resultStatusIsNot(svcId(svc), m.name, 'error')">
                            <span>
                              <span x-show="streamIsLive(svcId(svc), m.name)" class="result-ok"><span class="stream-live-dot"></span> ${S.receiving}</span>
                              <!-- 0.3.70:接收中实时计时 -->
                              <span x-show="streamIsLive(svcId(svc), m.name)" class="result-time" x-text="elapsedText(methodKey(svcId(svc), m.name))"></span>
                              <span x-show="streamIsCancelled(svcId(svc), m.name) && !streamIsCapped(svcId(svc), m.name)" class="result-err">${S.cancelled}</span>
                              <span x-show="(streamIsDone(svcId(svc), m.name) && !streamIsCancelled(svcId(svc), m.name)) || streamIsCapped(svcId(svc), m.name)" class="result-ok">${S.done}</span>
                            </span>
                          </template>
                          <span x-show="streamIsDone(svcId(svc), m.name)" class="result-time" x-text="streamDurationText(svcId(svc), m.name)"></span>
                          <span x-show="getStream(svcId(svc), m.name)" class="result-time" x-text="streamChunkCountText(svcId(svc), m.name)"></span>
                        </div>
                        <div class="result-actions">
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="streamIsLive(svcId(svc), m.name)"
                            @click="cancelStream(svcId(svc), m.name)"
                          >${S.cancel}</button>
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="streamIsTreeable(svcId(svc), m.name)"
                            @click="expandAllChunks(svcId(svc), m.name)"
                          >${S.expandAll}</button>
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="streamIsTreeable(svcId(svc), m.name)"
                            @click="collapseAllChunks(svcId(svc), m.name)"
                          >${S.collapseAll}</button>
                          <!-- 0.3.70:原始 JSON / 折叠树切换 -->
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="streamIsTreeable(svcId(svc), m.name)"
                            @click="toggleRaw(methodKey(svcId(svc), m.name))"
                            x-text="isRawOpen(methodKey(svcId(svc), m.name)) ? $store.str.treeTab : $store.str.rawTab"
                          ></button>
                          <button
                            type="button"
                            class="btn btn-secondary"
                            @click="copyStreamResult(svcId(svc), m.name)"
                            x-text="isCopied(svcId(svc), m.name) ? $store.str.copied : $store.str.copy"
                          ></button>
                        </div>
                      </div>
                      <!-- 0.3.70:流出错时错误横幅与已收 chunk 树并存(此前互斥,出错即丢已收数据) -->
                      <div x-show="streamErrorText(svcId(svc), m.name)" class="json-error stream-error-banner" x-text="streamErrorText(svcId(svc), m.name)"></div>
                      <div class="resp-meta" x-show="hasRespMeta(svcId(svc), m.name)">
                        <div
                          class="resp-meta-toggle"
                          role="button"
                          tabindex="0"
                          :aria-expanded="isRespMetaOpen(svcId(svc), m.name)"
                          @click="toggleRespMeta(svcId(svc), m.name)"
                          @keydown.enter.prevent="toggleRespMeta(svcId(svc), m.name)"
                          @keydown.space.prevent="toggleRespMeta(svcId(svc), m.name)"
                        >
                          <span class="collapse-icon" x-text="isRespMetaOpen(svcId(svc), m.name) ? '▼' : '▶'"></span>
                          <span>${S.respMetaTitle}</span>
                          <span class="resp-meta-count" x-text="respMetaCountText(svcId(svc), m.name)"></span>
                        </div>
                        <div x-show="isRespMetaOpen(svcId(svc), m.name)" class="resp-meta-body">
                          <template x-for="(entry, eIdx) in respMetaEntries(svcId(svc), m.name)" :key="eIdx">
                            <div class="resp-meta-row">
                              <span class="resp-meta-source" x-text="entry.source"></span>
                              <span class="resp-meta-key" x-text="entry.key"></span>
                              <span class="resp-meta-value" x-text="entry.value"></span>
                            </div>
                          </template>
                        </div>
                      </div>
                      <!-- 0.3.41:每 chunk 一条折叠条,条内同款折叠树;无 chunk 的错误流退化为原始 <pre>。0.3.70:Raw 开关可强制看原始 JSON -->
                      <div x-show="streamIsTreeable(svcId(svc), m.name) && !isRawOpen(methodKey(svcId(svc), m.name))" class="stream-tree">
                        <template x-for="sec in chunkSections(svcId(svc), m.name)" :key="sec.idx">
                          <div class="chunk-section">
                            <div
                              class="chunk-toggle"
                              role="button"
                              tabindex="0"
                              :aria-expanded="isChunkTreeOpen(svcId(svc), m.name, sec.idx)"
                              @click="toggleChunkTree(svcId(svc), m.name, sec.idx)"
                              @keydown.enter.prevent="toggleChunkTree(svcId(svc), m.name, sec.idx)"
                              @keydown.space.prevent="toggleChunkTree(svcId(svc), m.name, sec.idx)"
                            >
                              <span class="collapse-icon" x-text="isChunkTreeOpen(svcId(svc), m.name, sec.idx) ? '▼' : '▶'"></span>
                              <span class="chunk-label" x-text="sec.label"></span>
                            </div>
                            <div x-show="isChunkTreeOpen(svcId(svc), m.name, sec.idx)" class="chunk-tree">
                              <template x-for="row in chunkTreeRows(svcId(svc), m.name, sec.idx)" :key="row.path">
                                <div
                                  class="tree-row"
                                  :class="{ 'tree-row-container': row.children && row.children.length }"
                                  :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                                  @click.stop="row.children && row.children.length ? toggleTreeNode(svcId(svc), m.name, row.path) : null"
                                >
                                  <span x-show="row.children && row.children.length" class="collapse-icon" x-text="isTreeNodeOpen(svcId(svc), m.name, row.path) ? '▼' : '▶'"></span>
                                  <span x-show="!(row.children && row.children.length)" class="tree-spacer"></span>
                                  <span x-show="row.key" class="tree-key" x-text="row.key"></span>
                                  <span x-show="row.key" class="tree-colon">:</span>
                                  <span class="tree-value" :class="'tree-value-' + row.kind" x-text="row.value"></span>
                                  <span x-show="row.count" class="tree-count" x-text="row.count"></span>
                                </div>
                              </template>
                            </div>
                          </div>
                        </template>
                      </div>
                      <pre x-show="(getStream(svcId(svc), m.name) || getResult(svcId(svc), m.name)) && (!streamIsTreeable(svcId(svc), m.name) || isRawOpen(methodKey(svcId(svc), m.name)))" class="result-body" x-text="getStreamBody(svcId(svc), m.name)"></pre>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>
    </div>

    <div x-show="$store.workbench.view === 'sequence'">
      <div class="card seq-controls">
        <div class="seq-controls-row">
          <input type="text" class="seq-name" x-model="seqName" placeholder="${S.seqNamePlaceholder}" autocomplete="off">
          <button type="button" class="btn btn-secondary" @click="saveSequence()">${S.seqSave}</button>
          <button
            type="button"
            class="btn"
            :disabled="seqRunning || seqSteps.length === 0 || $store.workbench.connState === 'fail'"
            @click="runSequence()"
          >
            <span x-show="!seqRunning">${S.seqRun}</span>
            <span x-show="seqRunning">${S.seqRunning}</span>
          </button>
          <button type="button" class="btn btn-secondary" :disabled="seqStopping" x-show="seqRunning" @click="stopSequence()">
            <span x-show="!seqStopping">${S.seqStop}</span>
            <span x-show="seqStopping"><span class="proto-loading-spinner"></span>${S.seqStopping}</span>
          </button>
          <!-- 常驻控件条上的「结束并继续」:报告行内同款按钮随 chunk 高频重渲染可能吞点击,此按钮不重渲染(0.3.62) -->
          <button type="button" class="btn btn-secondary" :disabled="seqStopping" x-show="seqHasRunningStream()" @click="endSeqStream()">
            <span x-show="!seqStopping">${S.seqEndStream}</span>
            <span x-show="seqStopping"><span class="proto-loading-spinner"></span>${S.seqStopping}</span>
          </button>
        </div>
        <p x-show="$store.workbench.connState === 'fail'" class="unsupported-hint" x-text="$store.str.svcUnavailable"></p>
        <p x-show="seqNotice" class="seq-notice" :class="'seq-notice-' + seqNoticeKind" role="status" aria-live="polite" x-text="seqNotice"></p>
      </div>

      <!-- 序列内二级 tab(0.3.62):步骤编辑 / 运行报告 分容器,避免整页纵向堆叠过长;控件条常驻两者之上 -->
      <div class="view-tabs">
        <button type="button" class="view-tab" :class="{ 'view-tab-active': seqTab === 'steps' }" @click="setSeqTab('steps')">${S.seqStepsTab}</button>
        <button type="button" class="view-tab" :class="{ 'view-tab-active': seqTab === 'report' }" @click="setSeqTab('report')">${S.seqReportTab}</button>
      </div>

      <div x-show="seqTab === 'steps'">
      <div class="card" x-show="seqSaved.length > 0">
        <div class="card-title">${S.seqSavedTitle}</div>
        <template x-for="s in seqSaved" :key="s.name">
          <div class="seq-saved-row">
            <span class="seq-saved-name" x-text="s.name"></span>
            <span class="seq-saved-count" x-text="s.steps.length"></span>
            <button type="button" class="btn btn-secondary btn-xs" @click="loadSequence(s.name)">${S.seqLoad}</button>
            <button type="button" class="btn btn-secondary btn-xs" @click="deleteSequence(s.name)">${S.seqDelete}</button>
          </div>
        </template>
      </div>

      <div class="empty-state" x-show="seqSteps.length === 0">
        <p>${S.seqEmptySteps}</p>
        <!-- 0.3.84:空态给行动出口 -->
        <button type="button" class="btn btn-secondary" @click="setView('services')">${S.goToServices}</button>
      </div>

      <template x-for="(step, sIdx) in seqSteps" :key="step.id">
        <div class="card seq-step">
          <div class="seq-step-head">
            <span class="seq-step-idx" x-text="'#' + (sIdx + 1)"></span>
            <!-- 0.3.63 步骤入参默认折叠:点方法名或折叠图标展开/收起 -->
            <span
              class="seq-step-name seq-step-toggle"
              role="button"
              tabindex="0"
              :aria-expanded="isSeqStepOpen(step.id)"
              @click="toggleSeqStep(step.id)"
              @keydown.enter.prevent="toggleSeqStep(step.id)"
              @keydown.space.prevent="toggleSeqStep(step.id)"
              x-text="step.method"
            ></span>
            <span class="seq-step-svc" x-text="step.service"></span>
            <span x-show="step.responseStream" class="method-stream-badge">stream</span>
            <span class="collapse-icon seq-step-toggle" @click="toggleSeqStep(step.id)" x-text="isSeqStepOpen(step.id) ? '▼' : '▶'"></span>
            <span class="seq-step-actions">
              <button type="button" class="btn btn-secondary btn-xs" :disabled="sIdx === 0" @click="moveStep(sIdx, -1)">${S.seqStepUp}</button>
              <button type="button" class="btn btn-secondary btn-xs" :disabled="sIdx === seqSteps.length - 1" @click="moveStep(sIdx, 1)">${S.seqStepDown}</button>
              <button type="button" class="btn btn-secondary btn-xs" @click="removeStep(sIdx)">${S.seqStepRemove}</button>
            </span>
          </div>
          <p x-show="!stepMethod(step)" class="unsupported-hint">${S.seqMethodMissing}</p>
          <template x-if="stepMethod(step)">
            <div class="method-panel" x-show="isSeqStepOpen(step.id)">
              <!-- 0.3.64 步级 metadata 覆盖:初始空(不快照全局),同名 key 运行时覆盖全局 -->
              <div class="headers-editor">
                <div class="headers-editor-head">
                  <span class="headers-title">${S.seqHeadersOverride}</span>
                  <button type="button" class="btn btn-secondary btn-xs" @click="addHeaderRow(step.id, true)">${S.addHeader}</button>
                </div>
                <template x-for="(h, hIdx) in getHeaders(step.id, true)" :key="hIdx">
                  <div class="header-row">
                    <input
                      type="text"
                      class="header-key"
                      :value="h.key"
                      @input="setHeaderField(step.id, hIdx, 'key', $event.target.value)"
                      placeholder="${S.headerKeyPlaceholder}"
                      autocomplete="off"
                    >
                    <input
                      type="text"
                      class="header-value"
                      :value="h.value"
                      @input="setHeaderField(step.id, hIdx, 'value', $event.target.value)"
                      placeholder="${S.headerValuePlaceholder}"
                      autocomplete="off"
                    >
                    <button type="button" class="btn btn-secondary btn-xs header-remove" @click="removeHeaderRow(step.id, hIdx)">×</button>
                  </div>
                </template>
              </div>
              <div class="editor-tabs" x-show="stepMethod(step).requestFields.length > 0">
                <!-- 0.3.71:两个 tab 包 group,避免父级 space-between 把 Form/JSON 推向两端 -->
                <span class="editor-tabs-group">
                  <button type="button" class="editor-tab" :class="{ 'editor-tab-active': getEditorMode(step.id) === 'form' }" @click="setEditorMode(step.id, 'form', stepMethod(step))">${S.formTab}</button>
                  <button type="button" class="editor-tab" :class="{ 'editor-tab-active': getEditorMode(step.id) === 'json' }" @click="setEditorMode(step.id, 'json', stepMethod(step))">JSON</button>
                </span>
              </div>
              <div x-show="showFormPane(step.id, stepMethod(step))">
                <template x-for="(row, reqIdx) in flattenFormFields(stepMethod(step).requestFields)" :key="step.id + '-req-' + reqIdx">
                  <div>
                    <div
                      class="field-group"
                      :style="row.kind === 'group' ? 'padding-left:' + (row.depth * 14) + 'px' : 'display: none'"
                    >
                      <span class="field-group-name" x-text="row.field.name"></span>
                      <span class="field-type-badge" x-text="row.field.refType || 'message'"></span>
                    </div>
                    <div
                      class="field"
                      :style="row.kind === 'input' ? 'padding-left:' + (row.depth * 14 + 8) + 'px' : 'display: none'"
                    >
                      <label class="field-label">
                        <span x-text="row.field.name"></span>
                        <span class="field-type-badge"><span x-text="fieldTypeLabel(row.field)"></span></span>
                        <span x-show="row.field.optional" class="field-optional-badge">${S.optionalBadge}</span>
                        <span x-show="row.field.comment" class="field-comment" x-text="row.field.comment"></span>
                      </label>
                      <template x-if="row.field.protoType === 'TYPE_BOOL'">
                        <input type="checkbox" :checked="getFieldValue(step.id, row.path)" @change="setFieldValue(step.id, row.path, $event.target.checked)">
                      </template>
                      <template x-if="row.field.protoType === 'TYPE_ENUM' && row.field.enumValues && row.field.enumValues.length > 0">
                        <!-- 序列表入参是渲染前预填的:select 的 :value 会在 x-for options 渲染前赋值被浏览器丢弃(回落空)。
                             改 option 级 :selected,各 option 渲染时自判选中,与渲染顺序无关(0.3.62)。 -->
                        <select class="enum-select" @change="setFieldValue(step.id, row.path, $event.target.value)">
                          <option value="" :selected="!getFieldValue(step.id, row.path)">${S.selectPlaceholder}</option>
                          <template x-for="ev in row.field.enumValues" :key="ev.name">
                            <option :value="ev.name" :selected="getFieldValue(step.id, row.path) === ev.name" x-text="enumOptionLabel(ev, row.field.enumValues)"></option>
                          </template>
                        </select>
                      </template>
                      <template x-if="row.field.protoType === 'TYPE_ENUM' && (!row.field.enumValues || row.field.enumValues.length === 0)">
                        <input type="text" :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)" placeholder="${S.enumPlaceholder}">
                      </template>
                      <template x-if="row.field.protoType === 'TYPE_MESSAGE' && !row.wkt">
                        <textarea :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)" :placeholder="messagePlaceholder(row.field)"></textarea>
                      </template>
                      <template x-if="row.wkt">
                        <span class="wkt-input">
                          <input type="text" :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)" :placeholder="wktPlaceholder(row.wkt)">
                          <button type="button" class="btn btn-secondary btn-xs" x-show="row.wkt === 'Timestamp'" @click="setTimestampNow(step.id, row.path)">${S.timestampNow}</button>
                        </span>
                      </template>
                      <template x-if="row.field.protoType === 'TYPE_BYTES'">
                        <input type="text" :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)" placeholder="${S.bytesHint}" title="${S.bytesHint}">
                      </template>
                      <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.protoType !== 'TYPE_BYTES' && row.field.type === 'number'">
                        <input type="number" :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)">
                      </template>
                      <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.protoType !== 'TYPE_BYTES' && row.field.type !== 'number'">
                        <input type="text" :value="getFieldValue(step.id, row.path)" @input="setFieldValue(step.id, row.path, $event.target.value)">
                      </template>
                    </div>
                  </div>
                </template>
              </div>
              <div x-show="stepMethod(step).requestFields.length === 0" class="method-fields-empty">${S.noParams}</div>
              <div x-show="showJsonPane(step.id, stepMethod(step))">
                <textarea
                  class="json-editor"
                  spellcheck="false"
                  placeholder='{ "fileId": 1 }'
                  :value="getJsonText(step.id)"
                  @input="onJsonInput(step.id, $event.target.value)"
                ></textarea>
                <div x-show="getJsonError(step.id)" class="json-error" x-text="getJsonError(step.id)"></div>
              </div>
              <div x-show="hasJsonWarnings(step.id)" class="json-warning" x-text="jsonWarningText(step.id)"></div>

              <!-- 0.3.64 序列步级流接收上限:收满自动结束该步并推进;空 = 100,0 = 不限 -->
              <div class="seq-maxmsgs" x-show="step.responseStream">
                <span class="seq-maxmsgs-label">${S.seqMaxMessages}</span>
                <input
                  type="number"
                  min="0"
                  class="seq-maxmsgs-input"
                  :value="seqMaxMsgs[step.id] || ''"
                  @input="setSeqMaxMsgs(step.id, $event.target.value)"
                  placeholder="100"
                >
              </div>

              <!-- 0.3.78 步骤断言:路径相对 {data | chunks/count, durationMs};期望值可用 {{var}} / {{steps[i]...}} -->
              <div class="headers-editor seq-asserts">
                <div class="headers-editor-head">
                  <span class="headers-title">${S.assertTitle}</span>
                  <button type="button" class="btn btn-secondary btn-xs" @click="addAssert(step.id)">${S.addAssert}</button>
                </div>
                <template x-for="(a, aIdx) in getAsserts(step.id)" :key="aIdx">
                  <div class="header-row">
                    <input type="text" class="header-key" :value="a.path" @input="setAssertField(step.id, aIdx, 'path', $event.target.value)" placeholder="${S.assertPathPlaceholder}" autocomplete="off">
                    <select class="assert-op" @change="setAssertField(step.id, aIdx, 'op', $event.target.value)">
                      <template x-for="o in assertOps()" :key="o.op">
                        <option :value="o.op" :selected="a.op === o.op" x-text="o.label"></option>
                      </template>
                    </select>
                    <input type="text" class="header-value" x-show="assertNeedsExpected(a.op)" :value="a.expected" @input="setAssertField(step.id, aIdx, 'expected', $event.target.value)" placeholder="${S.assertExpectedPlaceholder}" autocomplete="off">
                    <button type="button" class="btn btn-secondary btn-xs header-remove" @click="removeAssert(step.id, aIdx)">×</button>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <!-- 占位符告警留在折叠外:折叠态也能看到前向/自引用问题(0.3.63) -->
          <div x-show="stepRefProblems(step, sIdx).length > 0" class="json-error">
            <template x-for="(prob, pIdx) in stepRefProblems(step, sIdx)" :key="pIdx">
              <div x-text="prob"></div>
            </template>
          </div>
        </div>
      </template>
      </div>

      <div x-show="seqTab === 'report'">
      <div class="empty-state" x-show="!hasSeqReport()">
        <p>${S.seqReportEmpty}</p>
      </div>
      <div class="card" x-show="hasSeqReport()">
        <div class="seq-report-actions">
          <div class="card-title" style="margin-right: auto;">${S.seqReportTitle}</div>
          <button type="button" class="btn btn-secondary btn-xs" x-show="hasSeqReport()" @click="toggleAllSeqReport()" x-text="allSeqReportOpen() ? $store.str.collapseAll : $store.str.expandAll"></button>
          <button type="button" class="btn btn-secondary" x-show="hasSeqReport()" @click="copySeqReport()">${S.seqCopyReport}</button>
        </div>
        <template x-for="entry in seqReportEntries()" :key="entry.index">
          <div class="seq-report-row" x-show="entry.status !== 'pending'">
            <div class="result-header">
              <div class="result-meta">
                <span class="seq-report-title" x-text="seqStepTitle(entry)"></span>
                <span x-show="entry.status === 'ok'" class="result-ok">${S.success}</span>
                <span x-show="entry.status === 'error'" class="result-err">${S.failed}</span>
                <span x-show="entry.status === 'running'" class="result-ok"><span class="stream-live-dot"></span> ${S.receiving}</span>
                <span x-show="entry.durationMs" class="result-time" x-text="entry.durationMs + 'ms'"></span>
                <span x-show="entry.responseStream" class="result-time" x-text="seqChunkCountText(entry)"></span>
                <button
                  type="button"
                  class="btn btn-secondary btn-xs"
                  :disabled="seqStopping"
                  x-show="entry.responseStream && entry.status === 'running'"
                  @click="endSeqStream()"
                >${S.seqEndStream}</button>
              </div>
            </div>
            <div class="seq-assert-results" x-show="entry.assertions.length > 0">
              <template x-for="(ar, arIdx) in entry.assertions" :key="arIdx">
                <div :class="ar.ok ? 'assert-pass' : 'assert-fail'" x-text="assertLine(ar)"></div>
              </template>
            </div>
            <!-- 0.3.81 一元:DevTools 风格折叠树(与普通结果同构);错误/无 data 退原始 <pre> -->
            <div x-show="!entry.responseStream && seqTreeAvailable(entry.index)" class="result-body result-tree">
              <template x-for="row in seqTreeRows(entry.index)" :key="row.path">
                <div
                  class="tree-row"
                  :class="{ 'tree-row-container': row.children && row.children.length }"
                  :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                  @click.stop="row.children && row.children.length ? seqToggleTreeNode(entry.index, row.path) : null"
                >
                  <span x-show="row.children && row.children.length" class="collapse-icon" x-text="seqIsTreeNodeOpen(entry.index, row.path) ? '▼' : '▶'"></span>
                  <span x-show="!(row.children && row.children.length)" class="tree-spacer"></span>
                  <span x-show="row.key" class="tree-key" x-text="row.key"></span>
                  <span x-show="row.key" class="tree-colon">:</span>
                  <span class="tree-value" :class="'tree-value-' + row.kind" x-text="row.value"></span>
                  <span x-show="row.count" class="tree-count" x-text="row.count"></span>
                </div>
              </template>
            </div>
            <pre class="result-body seq-report-body" x-show="!entry.responseStream && !seqTreeAvailable(entry.index)" x-text="entry.body || entry.error"></pre>
            <!-- 0.3.81 流式:每 chunk 一条折叠条,条内同款折叠树(与普通流结果同构) -->
            <div x-show="entry.responseStream && seqStreamTreeable(entry.index)" class="stream-tree">
              <template x-for="sec in seqChunkSections(entry.index)" :key="sec.idx">
                <div class="chunk-section">
                  <div
                    class="chunk-toggle"
                    role="button"
                    tabindex="0"
                    :aria-expanded="seqIsChunkTreeOpen(entry.index, sec.idx)"
                    @click="seqToggleChunkTree(entry.index, sec.idx)"
                    @keydown.enter.prevent="seqToggleChunkTree(entry.index, sec.idx)"
                    @keydown.space.prevent="seqToggleChunkTree(entry.index, sec.idx)"
                  >
                    <span class="collapse-icon" x-text="seqIsChunkTreeOpen(entry.index, sec.idx) ? '▼' : '▶'"></span>
                    <span class="chunk-label" x-text="sec.label"></span>
                  </div>
                  <div x-show="seqIsChunkTreeOpen(entry.index, sec.idx)" class="chunk-tree">
                    <template x-for="row in seqChunkTreeRows(entry.index, sec.idx)" :key="row.path">
                      <div
                        class="tree-row"
                        :class="{ 'tree-row-container': row.children && row.children.length }"
                        :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                        @click.stop="row.children && row.children.length ? seqToggleTreeNode(entry.index, row.path) : null"
                      >
                        <span x-show="row.children && row.children.length" class="collapse-icon" x-text="seqIsTreeNodeOpen(entry.index, row.path) ? '▼' : '▶'"></span>
                        <span x-show="!(row.children && row.children.length)" class="tree-spacer"></span>
                        <span x-show="row.key" class="tree-key" x-text="row.key"></span>
                        <span x-show="row.key" class="tree-colon">:</span>
                        <span class="tree-value" :class="'tree-value-' + row.kind" x-text="row.value"></span>
                        <span x-show="row.count" class="tree-count" x-text="row.count"></span>
                      </div>
                    </template>
                  </div>
                </div>
              </template>
            </div>
            <pre class="result-body seq-report-body" x-show="entry.responseStream && !seqStreamTreeable(entry.index) && entry.error" x-text="entry.error"></pre>
          </div>
        </template>
      </div>
      </div>
    </div>

    <!-- 0.3.67 回到顶部浮动按钮:滚动超阈值才显示(fixed 右下角) -->
    <button
      type="button"
      class="back-top"
      x-show="$store.workbench.backTop"
      :title="$store.str.backTop"
      @click="backToTop()"
    >${BACK_TOP_ICON_SVG}</button>
  </div>
</body>
</html>`;
}
