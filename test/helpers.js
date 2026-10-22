import { JSDOM } from 'jsdom'

/** Build the host's model-pane DOM shape used by the selector. */
export function createModelDom(options = {}) {
  const external = options.external === true
  const dom = new JSDOM(
    `<!doctype html>
<html>
  <body>
    <button id="settings-trigger" aria-haspopup="dialog" aria-label="设置">设置</button>
    <button id="model-trigger" aria-haspopup="menu" aria-expanded="true" aria-label="选择模型">模型</button>
    <div id="pane" role="group" aria-label="模型与推理等级">
      <div class="searchRow" id="native-search-row">
        <input id="native-search" role="searchbox" aria-label="搜索模型" placeholder="搜索模型">
      </div>
      ${external ? '<div class="dms-wrap" id="dms"><input id="dms-input" aria-label="search"></div>' : ''}
      <div role="menu" id="menu-models">
        <section data-menu-group data-menu-group-start>
          <div data-menu-group-heading>DeepSeek</div>
          <button role="menuitemradio" aria-checked="true" title="DeepSeek Chat">
            <span data-provider-id="deepseek" data-model-id="deepseek-chat">DeepSeek Chat</span>
          </button>
          <button role="menuitemradio" aria-checked="false" title="DeepSeek Reasoner">
            <span data-provider-id="deepseek" data-model-id="deepseek-reasoner">DeepSeek Reasoner</span>
          </button>
        </section>
        <section data-menu-group>
          <div data-menu-group-heading>OpenAI</div>
          <button role="menuitemradio" aria-checked="false" title="GPT-4o">
            <span data-provider-id="openai" data-model-id="gpt-4o">GPT-4o</span>
          </button>
          <button role="menuitemradio" aria-checked="false" title="GPT-4o mini">
            <span data-provider-id="openai" data-model-id="gpt-4o-mini">GPT-4o mini</span>
          </button>
        </section>
        <section data-menu-group>
          <div data-menu-group-heading>Anthropic</div>
          <button role="menuitemradio" aria-checked="false" title="Claude Sonnet">
            <span data-provider-id="anthropic" data-model-id="claude-sonnet">Claude Sonnet</span>
          </button>
        </section>
      </div>
    </div>
  </body>
</html>`,
    { url: 'http://localhost/' },
  )
  return dom
}

/** Minimal localStorage replacement with failure injection. */
export class FakeStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial))
    this.failWrites = false
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error('quota exceeded')
    this.map.set(key, String(value))
  }

  removeItem(key) {
    this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }
}

/** Read model keys from the fixture in DOM order. */
export function modelRows(dom) {
  return [...dom.window.document.querySelectorAll('button[role="menuitemradio"]')]
}

/** True when the row is hidden by the selector. */
export function isHidden(node) {
  return node.getAttribute('data-dsh-toolbox-hidden') === 'true'
}

/** Visible row keys in DOM order. */
export function visibleModelIds(dom) {
  return [...dom.window.document.querySelectorAll('button[role="menuitemradio"]')]
    .filter((node) => !isHidden(node))
    .map((node) => node.querySelector('[data-model-id]').getAttribute('data-model-id'))
}
