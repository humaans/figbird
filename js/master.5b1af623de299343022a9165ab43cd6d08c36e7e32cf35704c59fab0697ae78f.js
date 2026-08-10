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

  let ticking = false
  window.addEventListener('scroll', function () {
    if (!ticking) {
      window.requestAnimationFrame(function () {
        updateActiveLink()
        ticking = false
      })
      ticking = true
    }
  })

  updateActiveLink()
})
