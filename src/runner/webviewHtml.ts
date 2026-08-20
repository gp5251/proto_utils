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
  /** media/runner/alpine.min.js 的 asWebviewUri */
  alpineScriptUri: string;
  /** 顶栏显示的 gRPC server 地址 */
  server: string;
  /** 空态提示用的 proto 目录 */
  protoDir: string;
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

export function renderWorkbenchHtml(options: WorkbenchHtmlOptions): string {
  // 静态串 host 侧就地翻译;webview 内 Alpine 表达式求值的串经 boot.strings 下发,
  // webview 通过 $store.str.* / runner.js str() 读取({name} 占位符运行时替换)。
  const S = {
    title: l10n.t('RPC Workbench'),
    searchPlaceholder: l10n.t('Search services or methods...'),
    heading: l10n.t('RPC Services'),
    refresh: l10n.t('Refresh'),
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
      'No workspace folder is open and no proto directory is configured. Open a folder with .proto files via "File → Open Folder", or configure <code>protoUtils.runner.protoDir</code> in Settings (absolute paths work).',
    ),
    methodCountSuffix: l10n.t(' methods'),
    copiedBadge: l10n.t('✓ Copied'),
    responseTypeLabel: l10n.t('Response Type'),
    noFields: l10n.t('(no fields)'),
    optionalBadge: l10n.t('optional'),
    requiredBadge: l10n.t('required'),
    formTab: l10n.t('Form'),
    selectPlaceholder: l10n.t('-- Select --'),
    enumPlaceholder: l10n.t('Enum value'),
    noParams: l10n.t('(no parameters)'),
    send: l10n.t('Send'),
    sending: l10n.t('Sending...'),
    unsupportedStream: l10n.t('Client-streaming and bidi-streaming methods are not supported yet'),
    success: l10n.t('Success'),
    failed: l10n.t('Failed'),
    receiving: l10n.t('Receiving…'),
    cancelled: l10n.t('Cancelled'),
    done: l10n.t('Done'),
    cancel: l10n.t('Cancel'),
    headersTitle: l10n.t('Headers'),
    addHeader: l10n.t('Add header'),
    headerKeyPlaceholder: l10n.t('Header name'),
    headerValuePlaceholder: l10n.t('Header value'),
  };
  const strings = {
    copy: l10n.t('Copy'),
    copied: l10n.t('Copied'),
    refreshed: l10n.t('Refreshed · {count} services'),
    refreshedErrors: l10n.t('Refreshed · {count} services · {errors} parse errors'),
    chunkCount: l10n.t('{count} messages'),
    ignored: l10n.t('Ignored: {fields}'),
  };
  const boot = {
    server: options.server,
    protoDir: options.protoDir,
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
  <script nonce="${options.nonce}" src="${options.runnerScriptUri}"></script>
  <script nonce="${options.nonce}" defer src="${options.alpineScriptUri}"></script>
</head>
<body>
  <div class="topbar">
    <div class="topbar-search" x-data x-cloak>
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
      <h1 class="page-title">${S.heading}</h1>
      <div class="page-meta" x-data="pageMeta" x-cloak>
        <span><span class="dot"></span><span x-text="$store.workbench.server"></span></span>
        <button type="button" class="btn btn-secondary btn-xs" :disabled="$store.workbench.refreshing" @click="refresh()">
          <span x-show="!$store.workbench.refreshing">${S.refresh}</span>
          <span x-show="$store.workbench.refreshing"><span class="proto-loading-spinner"></span>${S.refreshing}</span>
        </button>
        <span class="refresh-notice" x-show="$store.workbench.refreshNotice" x-text="$store.workbench.refreshNotice" x-transition.opacity></span>
      </div>
    </div>

    <div class="card" id="proto-loading-card" x-show="$store.workbench.state === 'loading'">
      <div class="card-title"><span><span class="proto-loading-spinner"></span>${S.loadingTitle}</span></div>
      <p id="proto-loading-detail" class="proto-loading-detail">${S.loadingDetail}</p>
    </div>

    <div class="card error-card" id="proto-error-card" x-show="$store.workbench.errors.length > 0">
      <div class="card-title">${S.errorCardTitle}</div>
      <template x-for="(e, eIdx) in $store.workbench.errors" :key="eIdx">
        <p class="error-line" x-text="e"></p>
      </template>
    </div>

    <div x-show="$store.workbench.state === 'ready' && filteredServices().length === 0 && query.trim()" class="empty-state">
      <h2 style="font-size:16px">${S.noMatchTitle}</h2>
      <p>${S.noMatchHint}</p>
    </div>

    <div class="empty-state" x-show="$store.workbench.state === 'ready' && $store.workbench.services.length === 0 && !query.trim()">
      <h2 style="font-size:16px">${S.emptyTitle}</h2>
      <p x-show="$store.workbench.protoDir">${S.emptyDirPre} <code x-text="$store.workbench.protoDir"></code>${S.emptyDirPost}</p>
      <p x-show="!$store.workbench.protoDir">${S.emptyNoDir}</p>
    </div>

    <template x-for="svc in filteredServices()" :key="svc.name">
      <div class="card service-card">
        <div class="card-title card-title-toggle" @click="toggleService(svc.name)">
          <span>
            <span x-text="svc.name"></span>
            <span
              class="copy-icon"
              role="button"
              :title="$store.str.copy"
              x-show="!isServiceCopied(svc.name)"
              @click.stop="copyServiceName(svc.name)"
            >${COPY_ICON_SVG}</span>
            <span x-show="isServiceCopied(svc.name)" class="copy-badge">${S.copiedBadge}</span>
            <span style="font-weight:400;text-transform:none;color:var(--text-faint)">
              — <span x-text="filteredMethods(svc).length"></span>${S.methodCountSuffix}
            </span>
          </span>
          <span class="collapse-icon" x-text="isServiceOpen(svc.name) ? '▼' : '▶'"></span>
        </div>
        <div x-show="isServiceOpen(svc.name)">
          <template x-for="m in filteredMethods(svc)" :key="m.name">
            <div class="method-block">
              <div
                class="method-row"
                :id="'method-' + svc.name + '-' + m.name"
                :class="{ 'method-row-active': isMethodOpen(svc.name, m.name) }"
              >
                <span class="method-name" @click="toggleMethod(svc.name, m.name, m)">
                  <span x-text="m.name"></span>
                  <span
                    class="copy-icon"
                    role="button"
                    :title="$store.str.copy"
                    x-show="!isMethodCopied(svc.name, m.name)"
                    @click.stop="copyMethodName(svc.name, m.name)"
                  >${COPY_ICON_SVG}</span>
                  <span x-show="isMethodCopied(svc.name, m.name)" class="copy-badge">${S.copiedBadge}</span>
                </span>
                <span x-show="m.responseStream" class="method-stream-badge">stream</span>
                <span class="collapse-icon" x-text="isMethodOpen(svc.name, m.name) ? '▼' : '▶'"></span>
              </div>
              <template x-if="isMethodOpen(svc.name, m.name)">
                <div class="method-panel" @click.stop>
                  <div class="headers-editor">
                    <div class="headers-editor-head">
                      <span class="headers-title">${S.headersTitle}</span>
                      <button
                        type="button"
                        class="btn btn-secondary btn-xs"
                        @click="addHeaderRow(methodKey(svc.name, m.name))"
                      >${S.addHeader}</button>
                    </div>
                    <template x-for="(h, hIdx) in getHeaders(methodKey(svc.name, m.name))" :key="hIdx">
                      <div class="header-row">
                        <input
                          type="text"
                          class="header-key"
                          :value="h.key"
                          @input="setHeaderField(methodKey(svc.name, m.name), hIdx, 'key', $event.target.value)"
                          placeholder="${S.headerKeyPlaceholder}"
                          autocomplete="off"
                        >
                        <input
                          type="text"
                          class="header-value"
                          :value="h.value"
                          @input="setHeaderField(methodKey(svc.name, m.name), hIdx, 'value', $event.target.value)"
                          placeholder="${S.headerValuePlaceholder}"
                          autocomplete="off"
                        >
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs header-remove"
                          @click="removeHeaderRow(methodKey(svc.name, m.name), hIdx)"
                        >×</button>
                      </div>
                    </template>
                  </div>
                  <div class="method-schema">
                    <div class="method-schema-block">
                      <div class="method-type-row">
                        <span class="method-type-label">${S.responseTypeLabel}</span>
                        <span class="method-type-name" x-text="m.responseType"></span>
                      </div>
                      <div x-show="!(m.responseSchemaRows && m.responseSchemaRows.length)" class="method-fields-empty">${S.noFields}</div>
                      <template x-for="(row, rowIdx) in visibleSchemaRows(m.responseSchemaRows)" :key="m.name + '-res-' + rowIdx">
                        <div>
                          <div
                            class="method-field-row"
                            :class="{ 'method-field-row-expandable': (row.children && row.children.length) || (row.enumValues && row.enumValues.length) }"
                            :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                            @click.stop="(row.children && row.children.length) || (row.enumValues && row.enumValues.length) ? toggleRow(row.path) : null"
                          >
                            <span class="method-field-name" x-text="row.name"></span>
                            <span class="method-field-meta">
                              <span class="field-type-badge" x-text="row.typeLabel"></span>
                              <span x-show="row.optional" class="field-optional-badge">${S.optionalBadge}</span>
                              <span x-show="row.comment" class="field-comment" x-text="row.comment"></span>
                              <span
                                x-show="(row.children && row.children.length) || (row.enumValues && row.enumValues.length)"
                                class="collapse-icon"
                                x-text="isRowOpen(row.path) ? '▼' : '▶'"
                              ></span>
                            </span>
                          </div>
                          <div
                            x-show="row.enumValues && row.enumValues.length && isRowOpen(row.path)"
                            class="enum-values-list"
                            :style="'padding-left:' + (row.depth * 14 + 24) + 'px'"
                          >
                            <template x-for="ev in row.enumValues" :key="ev.name">
                              <div class="enum-value-item" x-text="enumOptionLabel(ev, row.enumValues)"></div>
                            </template>
                          </div>
                        </div>
                      </template>
                    </div>
                  </div>
                  <form class="form-section" @submit.prevent="sendFromEditor(svc.name, m.name, m)">
                    <div class="editor-tabs" x-show="m.requestFields.length > 0">
                      <button
                        type="button"
                        class="editor-tab"
                        :class="{ 'editor-tab-active': getEditorMode(methodKey(svc.name, m.name)) === 'form' }"
                        @click="setEditorMode(methodKey(svc.name, m.name), 'form', m)"
                      >${S.formTab}</button>
                      <button
                        type="button"
                        class="editor-tab"
                        :class="{ 'editor-tab-active': getEditorMode(methodKey(svc.name, m.name)) === 'json' }"
                        @click="setEditorMode(methodKey(svc.name, m.name), 'json', m)"
                      >JSON</button>
                    </div>
                    <div x-show="showFormPane(methodKey(svc.name, m.name), m)">
                    <template x-for="(row, reqIdx) in flattenFormFields(m.requestFields)" :key="m.name + '-req-' + reqIdx">
                      <div>
                        <div
                          x-show="row.kind === 'group'"
                          class="field-group"
                          :style="'padding-left:' + (row.depth * 14) + 'px'"
                        >
                          <span class="field-group-name" x-text="row.field.name"></span>
                          <span class="field-type-badge" x-text="row.field.refType || 'message'"></span>
                        </div>
                        <div
                          x-show="row.kind === 'input'"
                          class="field"
                          :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
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
                              @click.stop="toggleRow(row.path)"
                              x-text="isRowOpen(row.path) ? '▼' : '▶'"
                            ></span>
                          </label>
                          <div
                            x-show="isRowOpen(row.path) && ((row.field.nestedFields && row.field.nestedFields.length) || (row.field.enumValues && row.field.enumValues.length))"
                            class="method-schema-block"
                            :style="'margin-bottom: 10px; padding-left:' + (row.depth * 14 + 24) + 'px'"
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
                              <template x-for="(sRow, sIdx) in visibleSchemaRows(fieldSchemaRows(row.field))" :key="m.name + '-reqs-' + sIdx">
                                <div>
                                  <div
                                    class="method-field-row"
                                    :class="{ 'method-field-row-expandable': (sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length) }"
                                    :style="'padding-left:' + (sRow.depth * 14 + 8) + 'px'"
                                    @click.stop="(sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length) ? toggleRow(sRow.path) : null"
                                  >
                                    <span class="method-field-name" x-text="sRow.name"></span>
                                    <span class="method-field-meta">
                                      <span class="field-type-badge" x-text="sRow.typeLabel"></span>
                                      <span x-show="sRow.optional" class="field-optional-badge">${S.optionalBadge}</span>
                                      <span x-show="sRow.comment" class="field-comment" x-text="sRow.comment"></span>
                                      <span
                                        x-show="(sRow.children && sRow.children.length) || (sRow.enumValues && sRow.enumValues.length)"
                                        class="collapse-icon"
                                        x-text="isRowOpen(sRow.path) ? '▼' : '▶'"
                                      ></span>
                                    </span>
                                  </div>
                                  <div
                                    x-show="sRow.enumValues && sRow.enumValues.length && isRowOpen(sRow.path)"
                                    class="enum-values-list"
                                    :style="'padding-left:' + (sRow.depth * 14 + 24) + 'px'"
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
                              :checked="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @change="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.checked)"
                            >
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_ENUM' && row.field.enumValues && row.field.enumValues.length > 0">
                            <select
                              class="enum-select"
                              :value="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @change="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.value)"
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
                              :value="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @input="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.value)"
                              placeholder="${S.enumPlaceholder}"
                            >
                          </template>
                          <template x-if="row.field.protoType === 'TYPE_MESSAGE'">
                            <textarea
                              :value="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @input="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.value)"
                              placeholder='{ "key": "value" }'
                            ></textarea>
                          </template>
                          <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.type === 'number'">
                            <input
                              type="number"
                              :value="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @input="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.value)"
                            >
                          </template>
                          <template x-if="row.field.protoType !== 'TYPE_BOOL' && row.field.protoType !== 'TYPE_ENUM' && row.field.protoType !== 'TYPE_MESSAGE' && row.field.type !== 'number'">
                            <input
                              type="text"
                              :value="getFieldValue(methodKey(svc.name, m.name), row.path)"
                              @input="setFieldValue(methodKey(svc.name, m.name), row.path, $event.target.value)"
                            >
                          </template>
                        </div>
                      </div>
                    </template>
                    </div>
                    <div x-show="m.requestFields.length === 0" class="method-fields-empty">${S.noParams}</div>
                    <div x-show="showJsonPane(methodKey(svc.name, m.name), m)">
                      <textarea
                        class="json-editor"
                        spellcheck="false"
                        placeholder='{ "fileId": 1 }'
                        :value="getJsonText(methodKey(svc.name, m.name))"
                        @input="onJsonInput(methodKey(svc.name, m.name), $event.target.value)"
                      ></textarea>
                      <div
                        x-show="getJsonError(methodKey(svc.name, m.name))"
                        class="json-error"
                        x-text="getJsonError(methodKey(svc.name, m.name))"
                      ></div>
                    </div>
                    <div
                      x-show="hasJsonWarnings(methodKey(svc.name, m.name))"
                      class="json-warning"
                      x-text="jsonWarningText(methodKey(svc.name, m.name))"
                    ></div>

                    <div>
                      <button
                        type="button"
                        class="btn"
                        :disabled="isLoading(svc.name, m.name) || m.requestStream"
                        @click="sendFromEditor(svc.name, m.name, m)"
                      >
                        <span x-show="!isLoading(svc.name, m.name)">${S.send}</span>
                        <span x-show="isLoading(svc.name, m.name)">${S.sending}</span>
                      </button>
                      <p x-show="m.requestStream" class="unsupported-hint">${S.unsupportedStream}</p>
                    </div>
                  </form>

                  <template x-if="!m.responseStream">
                    <div
                      x-show="getResult(svc.name, m.name)"
                      class="result-section"
                    >
                      <div class="result-header">
                        <div class="result-meta">
                          <span
                            x-show="resultStatusIs(svc.name, m.name, 'ok')"
                            class="result-ok"
                          >${S.success}</span>
                          <span
                            x-show="resultStatusIsNot(svc.name, m.name, 'ok')"
                            class="result-err"
                          >${S.failed}</span>
                          <span class="result-time" x-text="resultDurationText(svc.name, m.name)"></span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          @click="copyResult(svc.name, m.name)"
                          x-text="isCopied(svc.name, m.name) ? $store.str.copied : $store.str.copy"
                        ></button>
                      </div>
                      <pre class="result-body" x-text="resultBodyText(svc.name, m.name)"></pre>
                    </div>
                  </template>

                  <template x-if="m.responseStream">
                    <div
                      x-show="getStream(svc.name, m.name) || getResult(svc.name, m.name)"
                      class="result-section"
                    >
                      <div class="result-header">
                        <div class="result-meta">
                          <template x-if="resultStatusIs(svc.name, m.name, 'error')">
                            <span class="result-err">${S.failed}</span>
                          </template>
                          <template x-if="resultStatusIsNot(svc.name, m.name, 'error')">
                            <span>
                              <span x-show="streamIsLive(svc.name, m.name)" class="result-ok"><span class="stream-live-dot"></span> ${S.receiving}</span>
                              <span x-show="streamIsCancelled(svc.name, m.name)" class="result-err">${S.cancelled}</span>
                              <span x-show="streamIsDone(svc.name, m.name) && !streamIsCancelled(svc.name, m.name)" class="result-ok">${S.done}</span>
                            </span>
                          </template>
                          <span x-show="streamIsDone(svc.name, m.name)" class="result-time" x-text="streamDurationText(svc.name, m.name)"></span>
                          <span x-show="getStream(svc.name, m.name)" class="result-time" x-text="streamChunkCountText(svc.name, m.name)"></span>
                        </div>
                        <div class="result-actions">
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="streamIsLive(svc.name, m.name)"
                            @click="cancelStream(svc.name, m.name)"
                          >${S.cancel}</button>
                          <button
                            type="button"
                            class="btn btn-secondary"
                            @click="copyStreamResult(svc.name, m.name)"
                            x-text="isCopied(svc.name, m.name) ? $store.str.copied : $store.str.copy"
                          ></button>
                        </div>
                      </div>
                      <pre class="result-body" x-text="getStreamBody(svc.name, m.name)"></pre>
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
</body>
</html>`;
}
