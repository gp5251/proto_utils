import { randomBytes } from 'node:crypto';
import type { ServicesPayload } from './serviceRegistry';

export interface WorkbenchHtmlOptions {
  /** webview.cspSource,放行 asWebviewUri 资源 */
  cspSource: string;
  /** 每面板随机 nonce,CSP 与所有 <script> 标签共用 */
  nonce: string;
  /** media/runner/runner.css 的 asWebviewUri */
  stylesUri: string;
  /** media/runner/runner.js 的 asWebviewUri */
  runnerScriptUri: string;
  /** media/runner/alpine.min.js 的 asWebviewUri */
  alpineScriptUri: string;
  /** 顶栏显示的 gRPC server 地址 */
  server: string;
  /** 空态提示用的 proto 目录 */
  protoDir: string;
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

export function renderWorkbenchHtml(options: WorkbenchHtmlOptions): string {
  const boot = {
    server: options.server,
    protoDir: options.protoDir,
    services: options.initialServices ?? null,
  };
  const csp = [
    `default-src 'none'`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${options.stylesUri}">
  <title>RPC 工作台</title>
  <script nonce="${options.nonce}">window.__PROTO_UTILS_BOOT__ = ${escapeInlineJson(boot)};</script>
  <script nonce="${options.nonce}" src="${options.runnerScriptUri}"></script>
  <script nonce="${options.nonce}" defer src="${options.alpineScriptUri}"></script>
</head>
<body>
  <div class="topbar">
    <div class="topbar-brand">RPC 工作台</div>
    <div class="topbar-search" x-data x-cloak>
      <input
        type="search"
        x-model="$store.search.query"
        placeholder="搜索服务或方法..."
        autocomplete="off"
      >
    </div>
    <div class="topbar-meta" x-data x-cloak>
      <span><span class="dot"></span><span x-text="$store.workbench.server"></span></span>
      <button type="button" class="btn btn-secondary btn-xs" @click="postRefresh()">刷新</button>
    </div>
  </div>
  <div class="container" x-data="homePage()" x-cloak>
    <h1 class="page-title">gRPC 服务</h1>

    <div class="card" id="proto-loading-card" x-show="$store.workbench.state === 'loading'">
      <div class="card-title"><span><span class="proto-loading-spinner"></span>正在解析 proto 文件…</span></div>
      <p id="proto-loading-detail" class="proto-loading-detail">首次启动或 proto 变更后需要重新解析，完成后页面将自动刷新。</p>
    </div>

    <div class="card error-card" id="proto-error-card" x-show="$store.workbench.errors.length > 0">
      <div class="card-title">Proto 加载错误</div>
      <template x-for="(e, eIdx) in $store.workbench.errors" :key="eIdx">
        <p class="error-line" x-text="e"></p>
      </template>
    </div>

    <div x-show="$store.workbench.state === 'ready' && filteredServices().length === 0 && query.trim()" class="empty-state">
      <h2 style="font-size:16px">无匹配结果</h2>
      <p>请尝试其他关键词</p>
    </div>

    <div class="empty-state" x-show="$store.workbench.state === 'ready' && $store.workbench.services.length === 0 && !query.trim()">
      <h2 style="font-size:16px">未找到服务</h2>
      <p>请将 <code>.proto</code> 文件添加到 <code x-text="$store.workbench.protoDir"></code>,或在设置中修改 <code>protoUtils.runner.protoDir</code> 指向你的 proto 目录</p>
    </div>

    <template x-for="svc in filteredServices()" :key="svc.name">
      <div class="card service-card">
        <div class="card-title card-title-toggle" @click="toggleService(svc.name)">
          <span>
            <span x-text="svc.name"></span>
            <span style="font-weight:400;text-transform:none;color:var(--text-faint)">
              — <span x-text="filteredMethods(svc).length"></span> 个方法
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
                  <span @click.stop="copyMethodName(svc.name, m.name)" x-text="m.name"></span>
                  <span x-show="isMethodCopied(svc.name, m.name)" class="copy-badge">✓ 已复制</span>
                </span>
                <span x-show="m.responseStream" class="method-stream-badge">stream</span>
                <span class="collapse-icon" x-text="isMethodOpen(svc.name, m.name) ? '▼' : '▶'"></span>
              </div>
              <template x-if="isMethodOpen(svc.name, m.name)">
                <div class="method-panel" @click.stop>
                  <div class="method-schema">
                    <div class="method-schema-block">
                      <div class="method-type-row">
                        <span class="method-type-label">返回类型</span>
                        <span class="method-type-name" x-text="m.responseType"></span>
                      </div>
                      <div x-show="!(m.responseSchemaRows && m.responseSchemaRows.length)" class="method-fields-empty">（无字段）</div>
                      <template x-for="(row, rowIdx) in visibleSchemaRows(m.responseSchemaRows)" :key="m.name + '-res-' + rowIdx">
                        <div>
                          <div
                            class="method-field-row"
                            :class="{ 'method-field-row-expandable': row.children?.length || row.enumValues?.length }"
                            :style="'padding-left:' + (row.depth * 14 + 8) + 'px'"
                            @click.stop="row.children?.length || row.enumValues?.length ? toggleRow(row.path) : null"
                          >
                            <span class="method-field-name" x-text="row.name"></span>
                            <span class="method-field-meta">
                              <span class="field-type-badge" x-text="row.typeLabel"></span>
                              <span x-show="row.optional" class="field-optional-badge">可选</span>
                              <span x-show="row.comment" class="field-comment" x-text="row.comment"></span>
                              <span
                                x-show="row.children?.length || row.enumValues?.length"
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
                  <form class="form-section" @submit.prevent="submitCall(svc.name, m.name, m)">
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
                            <span x-show="row.field.optional" class="field-optional-badge">可选</span>
                            <span x-show="row.field.required" class="field-required-badge">必填</span>
                            <span x-show="row.field.comment" class="field-comment" x-text="row.field.comment"></span>
                            <span
                              x-show="row.field.nestedFields?.length || row.field.enumValues?.length"
                              class="collapse-icon"
                              @click.stop="toggleRow(row.path)"
                              x-text="isRowOpen(row.path) ? '▼' : '▶'"
                            ></span>
                          </label>
                          <div
                            x-show="isRowOpen(row.path) && (row.field.nestedFields?.length || row.field.enumValues?.length)"
                            class="method-schema-block"
                            :style="'margin-bottom: 10px; padding-left:' + (row.depth * 14 + 24) + 'px'"
                          >
                            <div
                              x-show="row.field.protoType === 'TYPE_ENUM' && row.field.enumValues?.length"
                              class="enum-values-list"
                            >
                              <template x-for="ev in row.field.enumValues" :key="ev.name">
                                <div class="enum-value-item" x-text="enumOptionLabel(ev, row.field.enumValues)"></div>
                              </template>
                            </div>
                            <div x-show="row.field.protoType === 'TYPE_MESSAGE' && row.field.nestedFields?.length">
                              <template x-for="(sRow, sIdx) in visibleSchemaRows(fieldSchemaRows(row.field))" :key="m.name + '-reqs-' + sIdx">
                                <div>
                                  <div
                                    class="method-field-row"
                                    :class="{ 'method-field-row-expandable': sRow.children?.length || sRow.enumValues?.length }"
                                    :style="'padding-left:' + (sRow.depth * 14 + 8) + 'px'"
                                    @click.stop="sRow.children?.length || sRow.enumValues?.length ? toggleRow(sRow.path) : null"
                                  >
                                    <span class="method-field-name" x-text="sRow.name"></span>
                                    <span class="method-field-meta">
                                      <span class="field-type-badge" x-text="sRow.typeLabel"></span>
                                      <span x-show="sRow.optional" class="field-optional-badge">可选</span>
                                      <span x-show="sRow.comment" class="field-comment" x-text="sRow.comment"></span>
                                      <span
                                        x-show="sRow.children?.length || sRow.enumValues?.length"
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
                              <option value="">-- 请选择 --</option>
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
                              placeholder="枚举值"
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

                    <div>
                      <button
                        type="button"
                        class="btn"
                        :disabled="isLoading(svc.name, m.name) || m.requestStream"
                        @click="submitCall(svc.name, m.name, m)"
                      >
                        <span x-show="!isLoading(svc.name, m.name)">发送</span>
                        <span x-show="isLoading(svc.name, m.name)">发送中...</span>
                      </button>
                      <p x-show="m.requestStream" class="unsupported-hint">暂不支持客户端/双向流式方法</p>
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
                            x-show="getResult(svc.name, m.name)?.result?.status === 'ok'"
                            class="result-ok"
                          >成功</span>
                          <span
                            x-show="getResult(svc.name, m.name)?.result?.status !== 'ok'"
                            class="result-err"
                          >失败</span>
                          <span class="result-time" x-text="(getResult(svc.name, m.name)?.result?.durationMs ?? 0) + 'ms'"></span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-secondary"
                          @click="copyResult(svc.name, m.name)"
                          x-text="isCopied(svc.name, m.name) ? '已复制' : '复制'"
                        ></button>
                      </div>
                      <pre class="result-body" x-text="getResult(svc.name, m.name)?.resultBody ?? ''"></pre>
                    </div>
                  </template>

                  <template x-if="m.responseStream">
                    <div
                      x-show="getStream(svc.name, m.name) || getResult(svc.name, m.name)"
                      class="result-section"
                    >
                      <div class="result-header">
                        <div class="result-meta">
                          <template x-if="getResult(svc.name, m.name)?.result?.status === 'error'">
                            <span class="result-err">失败</span>
                          </template>
                          <template x-if="getResult(svc.name, m.name)?.result?.status !== 'error'">
                            <span>
                              <span x-show="getStream(svc.name, m.name) && !getStream(svc.name, m.name)?.done" class="result-ok"><span class="stream-live-dot"></span> 接收中…</span>
                              <span x-show="getStream(svc.name, m.name)?.done && getStream(svc.name, m.name)?.cancelled" class="result-err">已取消</span>
                              <span x-show="getStream(svc.name, m.name)?.done && !getStream(svc.name, m.name)?.cancelled" class="result-ok">完成</span>
                            </span>
                          </template>
                          <span x-show="getStream(svc.name, m.name)?.done" class="result-time" x-text="(getStream(svc.name, m.name)?.durationMs ?? 0) + 'ms'"></span>
                          <span x-show="getStream(svc.name, m.name)" class="result-time" x-text="(getStream(svc.name, m.name)?.chunks.length ?? 0) + ' 条消息'"></span>
                        </div>
                        <div class="result-actions">
                          <button
                            type="button"
                            class="btn btn-secondary"
                            x-show="getStream(svc.name, m.name) && !getStream(svc.name, m.name)?.done"
                            @click="cancelStream(svc.name, m.name)"
                          >取消</button>
                          <button
                            type="button"
                            class="btn btn-secondary"
                            @click="copyStreamResult(svc.name, m.name)"
                            x-text="isCopied(svc.name, m.name) ? '已复制' : '复制'"
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
