/* Progressive enhancement: the complete protocol reference works without JS. */
(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [
    ...scope.querySelectorAll(selector),
  ];
  const make = (tag, className, html = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.innerHTML = html;
    return node;
  };
  const number = (value) =>
    value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const chapters = [$("#overview"), ...$$("main > section")];
  const diagram = (items, label) =>
    `<div class="concept-flow" role="group" aria-label="${label}">${items
      .map(
        (item, i) =>
          `<div class="concept-node"><span class="node-index">0${
            i + 1
          }</span><strong>${item[0]}</strong><span>${item[1]}</span></div>${
            i < items.length - 1
              ? '<span class="flow-arrow" aria-hidden="true">→</span>'
              : ""
          }`
      )
      .join("")}</div>`;
  chapters.forEach((chapter, i) => {
    chapter.classList.add("guide-chapter");
    chapter.dataset.chapter = i;
    if (!i) return;
    const main = $(".main", chapter) || $(".devgrid", chapter) || chapter;
    const heading = $("h2", chapter);
    const body = make("div", "reference-body");
    // Keep existing elements, IDs and calculator event listeners intact.
    if (heading.parentElement !== main) heading.parentElement.before(heading);
    [...main.childNodes].forEach((node) => {
      if (node !== heading) body.append(node);
    });
    main.prepend(
      make(
        "div",
        "chapter-eyebrow",
        `CHAPTER ${String(i).padStart(2, "0")} <span>/ ${String(
          chapters.length - 1
        ).padStart(2, "0")}</span>`
      )
    );
    // Only interactive examples need a generated stage. Explanations live in HTML.
    if (chapter.id === "lifecycle") {
      const stage = make("div", "visual-stage");
      stage.id = `visual-${chapter.id}`;
      main.append(stage);
    }
    main.append(body);
  });

  // Replace the overview sentence with the same sequence as a diagram.
  const overview = $("#overview > div");
  $(".lede", overview).replaceWith(
    make(
      "div",
      "overview-journey",
      diagram(
        [
          ["Deposit", "Back one option with assets."],
          ["Earn premium", "The buyer pays at activation."],
          ["Claim", "Collect your share of what remains."],
        ],
        "Vault overview"
      )
    )
  );
  const progress = make("div", "reading-progress", "<span></span>");
  $(".topbar").append(progress);
  $(".rail summary").textContent = "Explore the guide";
  $$(".rail nav a").forEach((link) => {
    const target = document.getElementById(link.hash.slice(1));
    const index = chapters.indexOf(target);
    link.prepend(
      make(
        "span",
        "nav-number",
        index < 0 ? "↳" : String(index).padStart(2, "0")
      )
    );
  });

  const mobileLayout = matchMedia("(max-width: 760px)");
  const closeMobileContents = () => {
    if (mobileLayout.matches) $("#contents").open = false;
  };
  mobileLayout.addEventListener("change", closeMobileContents);
  closeMobileContents();

  const updateMotion = () => {
    document.documentElement.classList.toggle("still-guide", reducedMotion.matches);
    if (reducedMotion.matches)
      document.getAnimations().forEach((animation) => animation.finish());
  };
  reducedMotion.addEventListener("change", updateMotion);
  updateMotion();

  // The original section observer follows normal scrolling through the document.
  const updateProgress = () => {
    const available = document.documentElement.scrollHeight - innerHeight;
    $(".reading-progress span").style.width = `${
      available > 0
        ? Math.min(100, Math.max(0, (scrollY / available) * 100))
        : 0
    }%`;
  };
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  const followAnchor = () => {
    closeMobileContents();
    let target;
    try {
      target = document.getElementById(
        decodeURIComponent(location.hash.slice(1))
      );
    } catch (_) {}
    if (target) target.scrollIntoView({ block: "start", behavior: "instant" });
    markSection();
    updateProgress();
  };
  window.addEventListener("hashchange", followAnchor);

  // Move each original phase into its tab so the full rules have one home.
  const lifecycle = $("#visual-lifecycle");
  const timeline = $("#lifecycle .timeline");
  const phaseCards = $$(".card", timeline);
  const phaseNames = phaseCards.map((card) =>
    $(".name", card).textContent.trim()
  );
  lifecycle.innerHTML = `<span class="stage-label">WHO CAN ACT IN EACH PHASE</span><div class="phase-buttons" role="tablist" aria-label="Vault phase">${phaseNames
    .map(
      (name, i) =>
        `<button type="button" role="tab" id="phase-tab-${i}" data-phase="${i}" aria-controls="phase-panel-${i}" aria-selected="${
          i === 0
        }" tabindex="${i === 0 ? 0 : -1}"><span>0${i}</span>${name}</button>`
    )
    .join("")}</div>`;
  const phasePanels = phaseCards.map((card, i) => {
    const panel = make(
      "div",
      "phase-detail",
      `<span class="phase-watermark" aria-hidden="true">0${i}</span><div class="phase-rules"><h3>${phaseNames[i]}</h3></div>`
    );
    panel.id = `phase-panel-${i}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `phase-tab-${i}`);
    panel.tabIndex = 0;
    $(".phase-rules", panel).append($(".facts", card), $(".exit", card));
    lifecycle.append(panel);
    return panel;
  });
  const lifecycleIntro = $("#lifecycle .reference-body > .prose");
  if (lifecycleIntro) lifecycle.before(lifecycleIntro);
  if (timeline.previousElementSibling?.classList.contains("fig"))
    timeline.previousElementSibling.remove();
  timeline.remove();
  const phaseTabs = $$("[data-phase]", lifecycle);
  function setPhase(index, focus = false) {
    phaseTabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      phasePanels[i].hidden = i !== index;
    });
    lifecycle.dataset.phase = String(index);
    lifecycle.dispatchEvent(new Event("phase-state"));
    if (focus) phaseTabs[index].focus();
    updateProgress();
  }
  phaseTabs.forEach((tab, i) => {
    tab.onclick = () => setPhase(i);
    tab.onkeydown = (event) => {
      let index;
      if (event.key === "ArrowRight") index = (i + 1) % phaseTabs.length;
      if (event.key === "ArrowLeft")
        index = (i + phaseTabs.length - 1) % phaseTabs.length;
      if (event.key === "Home") index = 0;
      if (event.key === "End") index = phaseTabs.length - 1;
      if (index === undefined) return;
      event.preventDefault();
      setPhase(index, true);
    };
  });
  setPhase(0);

  document.body.classList.add("guide-ready");
  requestAnimationFrame(followAnchor);
})();
