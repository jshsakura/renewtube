// The toolbar switch. Flips `config.musicMode`; the content script on any open
// youtube.com tab reacts through storage.onChanged. If no YouTube tab is in
// front, turning the switch on opens one, since the mode has nowhere else to be.

import { DEFAULT_CONFIG, type Config } from '../shared/messages.ts'
import { applyScreenKind } from '../main/ui/device.ts'

// Before the first render: the popup is empty until this script fills it, and
// the browser sizes a desktop popup from whatever lands, so the class has to be
// in place before there is anything to size.
applyScreenKind()

const app = document.getElementById('app')!

async function read(): Promise<Config> {
  const got = await chrome.storage.local.get('config')
  return { ...DEFAULT_CONFIG, ...((got.config as Partial<Config> | undefined) ?? {}) }
}

async function render(): Promise<void> {
  const cfg = await read()
  app.innerHTML = `
    <h1>RenewTube</h1>
    <p>유튜브 화면을 심플한 플레이어로 바꿉니다. 재생은 그대로 유튜브가 합니다.</p>
    <div class="row">
      <span>켜기</span>
      <button class="switch" role="switch" aria-checked="${cfg.musicMode}" id="toggle"></button>
    </div>
    <p class="hint">화면 안의 종료 버튼으로도 끌 수 있습니다.</p>
    <div class="row">
      <span>화면 진단</span>
      <button class="btn" id="diag">불러오기</button>
    </div>
    <p class="hint">화면이 깨져서 설정을 열 수 없을 때도 여기서 뽑을 수 있습니다.</p>
    <textarea id="report" readonly hidden></textarea>
    <button class="btn wide" id="copy" hidden>복사</button>
  `
  document.getElementById('toggle')!.addEventListener('click', async () => {
    const next = { ...cfg, musicMode: !cfg.musicMode }
    await chrome.storage.local.set({ config: next })
    if (next.musicMode) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!/^https:\/\/[a-z]+\.youtube\.com\//.test(tab?.url ?? '')) {
        await chrome.tabs.create({ url: 'https://www.youtube.com/' })
      }
    }
    await render()
  })

  // ── The diagnosis, from here rather than from the page ───────────────────
  //
  // The same report the in-page settings screen shows. It lives here as well
  // because the one time anybody wants it is the time the screen is broken,
  // and a half-drawn sheet over a page that will not paint is not somewhere a
  // report can be read from ("화면이 막혀있는데 설정창은 반절만 나오고").
  // The popup is the browser's own furniture and owes the page nothing.
  const report = document.getElementById('report') as HTMLTextAreaElement
  const copy = document.getElementById('copy') as HTMLButtonElement
  const show = (text: string) => {
    report.value = text
    report.hidden = false
    copy.hidden = false
  }
  document.getElementById('diag')!.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !/^https:\/\/[a-z]+\.youtube\.com\//.test(tab.url ?? '')) {
      show('유튜브 탭에서 열어 주세요.')
      return
    }
    try {
      const answer = (await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' })) as { text?: string } | undefined
      show(answer?.text ? answer.text : '페이지가 답하지 않았습니다. 새로고침한 뒤 다시 해 주세요.')
    } catch {
      // No content script in that tab, or the page is still loading.
      show('이 탭에서는 확장이 아직 실행되지 않았습니다.')
    }
  })
  copy.addEventListener('click', () => {
    report.select()
    // The clipboard API needs a permission this extension does not ask for;
    // selecting and copying the field is what a popup can always do.
    try {
      document.execCommand('copy')
      copy.textContent = '복사했습니다'
      setTimeout(() => (copy.textContent = '복사'), 1500)
    } catch {
      copy.textContent = '길게 눌러 복사하세요'
    }
  })
}

void render()
