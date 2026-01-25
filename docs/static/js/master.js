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
    const scrollPos = window.scrollY + window.innerHeight / 2

    let current = null
    for (const { id, link, section } of sections) {
      if (section.offsetTop <= scrollPos) {
        current = link
      }
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
