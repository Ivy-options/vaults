(() => {
  const root = document.documentElement;
  const button = document.getElementById("themeToggle");
  const labelTheme = () =>
    (button.textContent = `Theme · ${root.dataset.theme}`);
  button.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("ivy-theme", root.dataset.theme);
    } catch (_) {}
    labelTheme();
  });
  labelTheme();
  const contents = document.getElementById("contents");
  const mobile = matchMedia("(max-width: 760px)");
  const closeMobileContents = () => {
    if (mobile.matches && contents) contents.open = false;
  };
  closeMobileContents();
  mobile.addEventListener("change", closeMobileContents);
  const links = [...document.querySelectorAll('.rail nav a[href^="#"]')];
  const sections = links.map((link) =>
    document.getElementById(decodeURIComponent(link.hash.slice(1)))
  );
  const markSection = () => {
    let current;
    for (let i = 0; i < sections.length; i++)
      if (sections[i].getBoundingClientRect().top <= 150) current = i;
    links.forEach((link, i) => {
      if (i === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  window.addEventListener("scroll", markSection, { passive: true });
  window.addEventListener("resize", markSection);
  window.addEventListener("hashchange", () => {
    closeMobileContents();
    markSection();
  });
  markSection();
})();
