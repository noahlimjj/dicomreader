// Popover menus anchored to a button.
const menu = document.getElementById('menu');
let closeHandler = null;

export function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
  document.removeEventListener('pointerdown', closeHandler, true);
  closeHandler = null;
}

export function isMenuOpen() {
  return !menu.hidden;
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{label, icon?, on?, disabled?, key?, action}|'-'|{title}>} items
 */
export function openMenu(anchor, items) {
  closeMenu();
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    if (it.title) {
      const t = document.createElement('div');
      t.className = 'menu-title';
      t.textContent = it.title;
      menu.appendChild(t);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.on) b.classList.add('on');
    b.disabled = !!it.disabled;
    if (it.id) b.dataset.id = it.id;
    b.innerHTML = `${it.icon ? `<svg><use href="#i-${it.icon}"/></svg>` : '<svg></svg>'}<span></span>${it.key ? `<span class="k">${it.key}</span>` : ''}`;
    b.querySelector('span').textContent = it.label;
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    menu.appendChild(b);
  }
  menu.hidden = false;
  // position: above a bottom toolbar button, below a top bar button
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = Math.min(vw - mw - 8, Math.max(8, r.left + r.width / 2 - mw / 2));
  let top = r.bottom + 6;
  if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  closeHandler = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler, true), 0);
}
