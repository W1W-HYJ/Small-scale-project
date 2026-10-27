'use strict'

// Pet window renderer: drag the pet, show the unread badge + new-item bubble, and
// open the digest panel.
//
// The sprite is not fixed any more: the main process picks a skin and pushes it in
// as a data: URL, so any imported picture works with no pre-generation step.
//
// There is no click-through. The window is exactly as wide as the sprite, so there
// is no empty strip that would need to pass clicks to the desktop — and toggling
// click-through turned out to be the thing that swallowed presses: the state change
// costs an IPC round trip, and a press arriving inside it went to the desktop while
// its release still landed on the pet. That produced exactly the "点不出来、右键也退
// 不出去" reports. The bubble is drawn over the sprite instead of beside it.

const img = document.getElementById('pet')
const bubble = document.getElementById('bubble')
const bubbleCount = document.getElementById('bubble-count')
const bubbleTitle = document.getElementById('bubble-title')
const badge = document.getElementById('badge')
const menu = document.getElementById('menu')

let dragging = false
let menuOpen = false
let pointerStart = null
let bubbleTimer = null
let menuTimer = null

/** A menu that cannot be dismissed is a trap: if nothing else can close it, time it out. */
const MENU_AUTO_CLOSE_MS = 20000

function closeMenu() {
  if (menuTimer) {
    clearTimeout(menuTimer)
    menuTimer = null
  }
  if (!menuOpen) return
  menuOpen = false
  menu.hidden = true
}

// Every press gets a line: "the pet stopped responding" is almost always
// "pointerdown never fired", and that is only distinguishable from outside if the
// presses are recorded.
window.addEventListener(
  'pointerdown',
  (event) => {
    const rect = img.getBoundingClientRect()
    const inImg = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
    window.pet.log(
      `pointerdown b=${event.button} at=${Math.round(event.clientX)},${Math.round(event.clientY)} ` +
        `tgt=${event.target === img ? 'img' : event.target?.id || event.target?.tagName} inImg=${inImg}`,
    )
  },
  true,
)

// --- skins ----------------------------------------------------------------

async function applySkinPayload(skin) {
  if (!skin || !skin.dataUrl) return
  img.src = skin.dataUrl
  try {
    await img.decode()
  } catch {
    await new Promise((resolve) => {
      img.onload = resolve
      img.onerror = resolve
    })
  }
  window.pet.log(`skin ${skin.id} ${img.naturalWidth}x${img.naturalHeight}`)
}

// --- dragging and clicking ------------------------------------------------
// Pointer capture makes the window receive the release even if the pointer
// outruns it, which matters because the window is chasing the cursor. A press
// that neither moves nor lingers is a click, and a click opens the digest.
img.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  closeMenu()
  dragging = true
  pointerStart = { x: event.screenX, y: event.screenY, at: Date.now() }
  document.body.classList.add('dragging')
  img.setPointerCapture(event.pointerId)
  window.pet.dragStart()
})

function endDrag() {
  if (!dragging) return
  dragging = false
  document.body.classList.remove('dragging')
  window.pet.dragEnd()
}

window.addEventListener('pointerup', (event) => {
  const wasDragging = dragging
  endDrag()
  if (!wasDragging || !pointerStart) {
    window.pet.log(`pointerup ignored wasDragging=${wasDragging} hasStart=${Boolean(pointerStart)}`)
    return
  }
  const moved = Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y)
  const held = Date.now() - pointerStart.at
  pointerStart = null
  window.pet.log(`pointerup moved=${moved.toFixed(1)} held=${held}ms`)
  if (moved < 6 && held < 700) {
    try {
      window.pet.activate()
    } catch (error) {
      window.pet.log(`activate threw ${error.message}`)
    }
  }
})

window.addEventListener('pointercancel', () => {
  window.pet.log(`pointercancel hasStart=${Boolean(pointerStart)} dragging=${dragging}`)
  pointerStart = null
  endDrag()
})

// --- menu -----------------------------------------------------------------
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  menuOpen = true
  menu.hidden = false
  if (menuTimer) clearTimeout(menuTimer)
  menuTimer = setTimeout(() => {
    window.pet.log('menu auto-closed after timeout')
    closeMenu()
  }, MENU_AUTO_CLOSE_MS)
})

window.addEventListener(
  'pointerdown',
  (event) => {
    if (menuOpen && !menu.contains(event.target)) closeMenu()
  },
  true,
)

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

document.getElementById('menu-digest').addEventListener('click', () => {
  closeMenu()
  window.pet.activate()
})

document.getElementById('menu-skin').addEventListener('click', () => {
  closeMenu()
  window.pet.openSkins()
})

document.getElementById('menu-refresh').addEventListener('click', () => {
  closeMenu()
  window.feed.refresh()
})

document.getElementById('menu-quit').addEventListener('click', () => window.pet.quit())

img.addEventListener('dragstart', (event) => event.preventDefault())

// --- digest signals -------------------------------------------------------

function renderBadge(unread) {
  const count = Number(unread) || 0
  if (count <= 0) {
    badge.hidden = true
    return
  }
  badge.hidden = false
  badge.textContent = count > 99 ? '99+' : String(count)
}

function showBubble(payload) {
  const count = Number(payload?.count) || 0
  if (count <= 0) return
  bubbleCount.textContent = count === 1 ? '新内容 1 条' : `新内容 ${count} 条`
  const title = (payload.topTitle || payload.titles?.[0] || '').trim()
  bubbleTitle.textContent = title || '点我查看摘要'
  bubble.classList.add('show')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), Number(payload.durationMs) || 9000)
}

/** The idle float is opt-in because it costs ~18% of a core (see style.css). */
function applyAnimationSetting(snapshot) {
  const on = Boolean(snapshot?.settings?.ui?.petAnimation)
  document.body.classList.toggle('animating', on)
}

function applySnapshot(snapshot) {
  renderBadge(snapshot?.unread)
  applyAnimationSetting(snapshot)
}

window.feed.onSnapshot(applySnapshot)
window.feed.onNew(showBubble)
window.pet.onSkin((skin) => applySkinPayload(skin))

window.feed
  .snapshot()
  .then(applySnapshot)
  .catch(() => {})

// The main process also pushes the skin on did-finish-load, but ask once more so
// a renderer that reloaded on its own still ends up with the right sprite.
window.pet
  .skin()
  .then((skin) => {
    if (skin && skin.dataUrl && img.src !== skin.dataUrl) applySkinPayload(skin)
  })
  .catch(() => {})
