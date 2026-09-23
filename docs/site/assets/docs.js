(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var root = document.documentElement;
  var themeBtn = $("themeToggle");
  try {
    var saved = localStorage.getItem("ivy-theme");
    if (saved === "light" || saved === "dark")
      root.setAttribute("data-theme", saved);
  } catch (e) {}
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  function labelTheme() {
    themeBtn.textContent = "Theme · " + currentTheme();
  }

  IvyLabs.mountAll(document);
  labelTheme();
  themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ivy-theme", next);
    } catch (e) {}
    labelTheme();
  });
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", labelTheme);
  }
})();

// Keep the section marker in step with reading and direct anchor navigation.
const sectionLinks = [...document.querySelectorAll(".rail nav a")];
const sections = sectionLinks.map((link) => document.querySelector(link.hash));
function markSection() {
  let current = sections[0];
  for (const section of sections)
    if (section.getBoundingClientRect().top <= 150) current = section;
  for (const link of sectionLinks) {
    if (link.hash === "#" + current.id)
      link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("scroll", markSection, { passive: true });
window.addEventListener("resize", markSection);
markSection();

if (window.matchMedia("(max-width: 760px)").matches)
  document.getElementById("contents").open = false;
