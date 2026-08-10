// Scroll spy for TOC highlighting
document.addEventListener('DOMContentLoaded', function () {
  const TOC = document.getElementById('TOC')
  if (!TOC) return

  const links = TOC.querySelectorAll('a[href^="#"]')
  if (!links.length) return

  const sections = []
  links.forEach(link => {
    const id = link.getAttribute('href').slice(1)
    const section = document.getElementById(id)
    if (section) {
      sections.push({ id, link, section })
    }
  })

  function updateActiveLink() {
    // Reading line near the top of the viewport — this is where anchor
    // navigation lands a heading, so the clicked item is the one that
    // highlights (a viewport-middle probe would already sit in the next
    // section for short sections).
    const scrollPos = window.scrollY + 80

    let current = null
    for (const { id, link, section } of sections) {
      if (section.offsetTop <= scrollPos) {
        current = link
      }
    }

    // At the very bottom, the last section wins even when its heading can
    // never scroll up to the reading line.
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    if (atBottom && sections.length > 0) {
      current = sections[sections.length - 1].link
    }

    links.forEach(link => link.classList.remove('active'))
    if (current) {
      current.classList.add('active')
    }
  }

  // No rAF gating: the update is a cheap loop, and a requestAnimationFrame
  // ticket never fires in a hidden tab — a stuck "ticking" flag would kill the
  // spy for the rest of the session after backgrounding mid-scroll.
  window.addEventListener('scroll', updateActiveLink, { passive: true })

  updateActiveLink()
})
