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
    if (["collateral", "lifecycle"].includes(chapter.id)) {
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
  const toolbar = make(
    "div",
    "guide-tools",
    '<button type="button" id="motion-toggle" aria-pressed="true">Motion on</button>'
  );
  $("#themeToggle").before(toolbar);
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

  let motionEnabled = !reducedMotion.matches;
  const updateMotion = () => {
    document.documentElement.classList.toggle(
      "still-guide",
      !motionEnabled || reducedMotion.matches
    );
    if (!motionEnabled || reducedMotion.matches)
      document.getAnimations().forEach((animation) => animation.finish());
    $("#motion-toggle").textContent =
      motionEnabled && !reducedMotion.matches ? "Motion on" : "Motion off";
    $("#motion-toggle").setAttribute(
      "aria-pressed",
      String(motionEnabled && !reducedMotion.matches)
    );
  };
  $("#motion-toggle").onclick = () => {
    motionEnabled = !motionEnabled;
    updateMotion();
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

  // Collateral: show exact whole-token exchanges for an explicitly selected amount.
  const collateral = $("#visual-collateral");
  collateral.innerHTML = `<div class="stage-top"><span class="stage-label">PHYSICAL DELIVERY · TRY IT</span><div class="segmented" role="group" aria-label="Option type"><button type="button" data-option="call" aria-pressed="true">Covered call</button><button type="button" data-option="put" aria-pressed="false">Cash-secured put</button></div></div>
    <div class="token-key"><span><i class="key-dot eth-dot"></i>Underlying <b>WETH</b></span><span><i class="key-dot usd-dot"></i>Quote <b>USDC</b></span><span>Premium <b>Claimed separately</b></span><span>Strike <b>3,000 USDC / WETH</b></span></div>
    <div class="transfer-scene"><div class="vault-node"><span class="node-caption">COLLATERAL DEPOSITED</span><span class="coin eth" id="deposit-coin">◇</span><strong id="deposit-amount">10 WETH</strong><span>Held in the vault</span></div><div class="transfer-lanes"><div class="transfer-lane outgoing"><span class="lane-direction">Vault → recipient</span><strong id="outgoing-amount"></strong><span class="lane-track"><i></i></span></div><div class="transfer-lane incoming"><span class="lane-direction">Caller → vault</span><strong id="incoming-amount"></strong><span class="lane-track"><i></i></span></div></div><div class="buyer-node"><span class="node-caption">OPTION BUYER</span><span class="coin buyer-icon">↔</span><strong>Exercise the right</strong><span>Caller pays · recipient receives</span></div></div>
    <div class="exercise-controls"><label for="exercise-amount">Amount exercised <output id="exercise-output" for="exercise-amount">10 WETH · 100%</output></label><input id="exercise-amount" type="range" min="0" max="10" step="1" value="10"><div class="range-ends"><span>None</span><span>Full 10 WETH</span></div><button class="play-transfer" type="button">Replay token flow <span aria-hidden="true">↗</span></button></div>
    <div class="pool-result" role="status"><span>POOL AFTER THIS EXERCISE</span><strong id="pool-amount"></strong><p id="exchange-caption"></p></div>
    <p class="stage-footnote">Illustrative partial exercise, where allowed by the vault. No exercise is an alternative outcome. Remaining collateral stays committed until finalization; premium is claimed separately. Raw-unit rounding is omitted.</p>`;
  let option = "call";
  let animations = [];
  function animateTransfer() {
    animations.forEach((animation) => animation.cancel());
    animations = [];
    if (
      !motionEnabled ||
      reducedMotion.matches ||
      Number($("#exercise-amount").value) === 0
    )
      return;
    $$(".lane-track", collateral).forEach((track, i) => {
      const distance = track.clientWidth - 10;
      animations.push(
        $("i", track).animate(
          [
            { transform: `translateX(${i ? distance : 0}px)`, opacity: 0 },
            { opacity: 1, offset: 0.18 },
            { opacity: 1, offset: 0.8 },
            { transform: `translateX(${i ? 0 : distance}px)`, opacity: 0 },
          ],
          { duration: 1100, easing: "cubic-bezier(.22,.61,.36,1)" }
        )
      );
    });
  }
  function renderExchange() {
    const amount = Number($("#exercise-amount").value);
    const call = option === "call";
    collateral.dataset.option = option;
    $("#deposit-amount").textContent = call ? "10 WETH" : "30,000 USDC";
    $("#deposit-coin").className = `coin ${call ? "eth" : "usd"}`;
    $("#deposit-coin").textContent = call ? "◇" : "$";
    $("#outgoing-amount").textContent = call
      ? `${amount} WETH`
      : `${number(amount * 3000)} USDC`;
    $("#incoming-amount").textContent = call
      ? `${number(amount * 3000)} USDC`
      : `${amount} WETH`;
    $("#exercise-output").textContent = `${amount} WETH · ${amount * 10}%`;
    $("#pool-amount").textContent = call
      ? `${10 - amount} WETH + ${number(amount * 3000)} USDC`
      : `${amount} WETH + ${number(30000 - amount * 3000)} USDC`;
    $("#exchange-caption").textContent =
      amount === 0
        ? "No tokens exchanged. The deposited collateral remains in the vault."
        : call
        ? "The vault delivers WETH and receives USDC at the agreed strike."
        : "The vault pays USDC at the agreed strike and receives WETH.";
    $(".play-transfer").disabled = amount === 0;
    $$("[data-option]").forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.option === option)
      )
    );
    animateTransfer();
  }
  $$("[data-option]").forEach(
    (button) =>
      (button.onclick = () => {
        option = button.dataset.option;
        renderExchange();
      })
  );
  $("#exercise-amount").oninput = renderExchange;
  $(".play-transfer").onclick = animateTransfer;
  renderExchange();
  animations.forEach((animation) => animation.cancel()); // No entrance autoplay.
  // The interactive exchange replaces the static example in the reading flow.
  $("#physical-delivery-example").replaceChildren(collateral);
  $("#physical-delivery-example").classList.add("interactive-delivery");

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
