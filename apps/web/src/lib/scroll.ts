/** Scroll to the first match once it renders, with a short highlight ring. */
export function scrollToWhenReady(selector: string, tries = 20) {
  const el = document.querySelector(selector)
  if (!el) {
    if (tries > 0) window.setTimeout(() => scrollToWhenReady(selector, tries - 1), 100)
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('ring-2', 'ring-teal/40')
  window.setTimeout(() => el.classList.remove('ring-2', 'ring-teal/40'), 1800)
}
