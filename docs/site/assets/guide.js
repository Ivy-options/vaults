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
  const summaries = {
    "option-basics": [
      "A right for the buyer. A premium for the seller.",
      "The buyer chooses whether to exercise. The vault backs the other side of that trade.",
    ],
    collateral: [
      "Follow the tokens.",
      "Follow the tokens from deposit to exercise, then see what shares and premium let you claim.",
    ],
    lifecycle: [
      "One vault. One trade. Four phases.",
      "Choose a phase to see what becomes possible, and what stays locked.",
    ],
    "premium-treatment": [
      "Earned premium stays earned.",
      "Cancelling an auction and unwinding a live option are different actions. A pause does not stop the clock.",
    ],
    "platform-fees": [
      "One premium, two allocations.",
      "The fee comes out of the buyer’s gross premium at activation. LPs can claim the remainder immediately.",
    ],
    outcomes: [
      "Move the price. See the trade-off.",
      "Premium adds income, but the value of the assets you receive can still fall.",
    ],
    makers: [
      "From signed bid to exercise.",
      "The bid master submits the chosen bid. The contracts check its terms before the option becomes active.",
    ],
    "cash-settlement": [
      "Settle the difference in collateral.",
      "Cash settlement is optional. It uses finalized settlement prices, and its exercise rules differ from physical delivery.",
    ],
    terms: [
      "Set the boundaries before deposits.",
      "The owner chooses the terms. While Open, the owner can tighten protections, but cannot relax them.",
    ],
    versions: [
      "A new version starts with a new vault.",
      "Existing vaults keep the implementation and modules recorded when they were created.",
    ],
    developers: [
      "The hub coordinates. The vault holds tokens.",
      "Follow the contract responsibilities before choosing an entrypoint.",
    ],
  };
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
  const visualContent = {
    "option-basics":
      diagram(
        [
          ["LPs deposit", "Assets back the seller’s obligation."],
          ["Buyer pays", "Premium buys the option’s rights."],
          ["Option ends", "Shareholders claim the remaining pool."],
        ],
        "The option trade"
      ) +
      '<div class="choice-pair"><div><span class="coin eth">↑</span><h3>Call = right to buy</h3><p>The buyer can buy the underlying at the strike.</p></div><div><span class="coin usd">↓</span><h3>Put = right to sell</h3><p>The buyer can sell the underlying at the strike.</p></div></div><p class="takeaway">The premium pays LPs for an obligation. It does not guarantee their final return.</p>',
    "premium-treatment":
      '<div class="event-list"><div><span class="event-dot"></span><h3>Auction cancelled</h3><p>No premium collected. The vault returns to Open.</p></div><div><span class="event-dot violet"></span><h3>Live option unwound</h3><p>Earned premium and fees stay earned. Any agreed buyer refund is funded separately by current LPs.</p></div><div><span class="event-dot orange"></span><h3>Admission paused</h3><p>Exercise, expiration and claims remain available. Deadlines stay fixed.</p></div></div>',
    "cash-settlement":
      diagram(
        [
          ["Report price", "The authorized reporter submits a price."],
          ["Wait & finalize", "The configured dispute process must finish."],
          ["Settle & claim", "Buyer payout is reserved in collateral."],
        ],
        "Cash settlement price flow"
      ) +
      '<div class="choice-pair"><div><h3>Physical delivery</h3><p>Exchange underlying and quote tokens at the agreed strike.</p></div><div><h3>Cash settlement</h3><p>Pay the option’s value in the collateral token using the finalized price.</p></div></div><p class="takeaway">European cash options settle from the finalized expiry price. They have no manual exercise.</p>',
    terms:
      '<div class="boundary"><span class="boundary-label">CREATED</span><div><strong>Terms set the allowed trade</strong><p>Underlying, token pairs, strike limits, minimum premium, expiry and exercise policy.</p><div class="boundary-inner"><span class="boundary-label">WHILE OPEN</span><strong>Protections can tighten</strong><p>For example, raise the minimum premium or narrow allowed settlement types. Immutable fields stay fixed.</p></div></div></div><p class="takeaway">Activation rejects a winning bid that falls outside the vault’s current terms.</p>',
    versions:
      '<div class="choice-pair"><div><span class="chapter-eyebrow">EXISTING VAULT</span><h3>Its recorded contracts</h3><p>Keeps the implementation and settlement modules it started with.</p></div><div><span class="chapter-eyebrow">NEW VAULT</span><h3>The selected version</h3><p>Uses the configured implementation and modules for new creation.</p></div></div><p class="takeaway">Check the individual vault’s recorded configuration when integrating with it.</p>',
    developers:
      diagram(
        [
          ["IvyVaultsHub", "Coordinates operations and permissions."],
          ["IvyVault", "Pulls and holds this vault’s tokens."],
          ["IvyShares", "Tracks ERC-1155 shares by vault ID."],
        ],
        "Contract responsibilities, not a token transfer path"
      ) +
      '<p class="takeaway">Token approvals target the individual vault address. The hub does not take custody.</p>',
  };

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
    const [title, intro] = summaries[chapter.id];
    main.prepend(
      make(
        "div",
        "chapter-eyebrow",
        `CHAPTER ${String(i).padStart(2, "0")} <span>/ ${String(
          chapters.length - 1
        ).padStart(2, "0")}</span>`
      )
    );
    heading.after(
      make(
        "div",
        "chapter-intro",
        `<p class="visual-title">${title}</p><p>${intro}</p>`
      )
    );
    const stage = make("div", "visual-stage", visualContent[chapter.id] || "");
    stage.id = `visual-${chapter.id}`;
    if (chapter.id === "makers") main.append(body);
    else main.append(stage, body);
  });

  // Introduce the visual examples before the continuous reference.
  const overview = $("#overview > div");
  $(".kicker", overview).textContent = "THE VISUAL GUIDE";
  $("h1", overview).innerHTML =
    "Ivy Vaults,<br><span>one step at a time.</span>";
  overview.append(
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

  const fees = $("#visual-platform-fees");
  fees.innerHTML =
    '<span class="stage-label">WORKED EXAMPLE · 2% FEE</span><div class="fee-total"><span>Buyer pays gross premium</span><strong>1,000 <small>USDC</small></strong></div><div class="fee-bar" role="img" aria-label="980 USDC to LPs and 20 USDC to treasury"><span></span><i></i></div><div class="fee-labels"><div><span>98% · LP premium</span><strong>980 USDC</strong></div><div><span>2% · Treasury fee</span><strong>20 USDC</strong></div></div><p class="stage-footnote">Illustrative rate. Activation uses the current global fee rate and rejects it if it exceeds the vault’s creation-time cap.</p>';

  // An illustrative price/value chart. Keep the original editable calculator intact.
  const outcomes = $("#visual-outcomes");
  outcomes.innerHTML = `<div class="stage-top"><span class="stage-label">LP VALUE · PRICE EXPLORER</span><div class="segmented" role="group" aria-label="Payoff option type"><button type="button" data-payoff="call" aria-pressed="true">Call</button><button type="button" data-payoff="put" aria-pressed="false">Put</button></div></div><div class="payoff-layout"><div><svg class="explorer-chart" viewBox="0 0 560 290" role="img" aria-label="LP total value with premium versus holding collateral"><g class="chart-grid"><path d="M55 25V242H530 M55 169H530 M55 97H530 M55 25H530"/></g><text x="14" y="246">0</text><text x="8" y="173">15k</text><text x="8" y="101">30k</text><text x="8" y="29">45k</text><text x="55" y="272">1,500</text><text x="292.5" y="272" text-anchor="middle">3,000 strike</text><text x="530" y="272" text-anchor="end">4,500</text><path class="strike-guide" d="M292.5 25V242"/><path class="hold-path"/><path class="vault-path" d="M55 164.84L292.5 92.51H530"/><path class="price-guide"/><circle class="value-dot" r="6"/></svg><div class="chart-legend"><span><i></i>LP value + premium</span><span><i></i>Hold collateral</span></div></div><div class="value-readout" role="status"><span>LP total value</span><strong id="explorer-value"></strong><span>USDC equivalent</span><div><span>Compared with holding</span><b id="explorer-difference"></b></div></div></div><label class="price-label" for="market-price">Illustrative WETH price <output id="market-output"></output></label><input id="market-price" type="range" min="1500" max="4500" step="50" value="3500"><div class="range-ends"><span>1,500 USDC</span><span>4,500 USDC</span></div><p class="takeaway" id="payoff-takeaway"></p><p class="stage-footnote">10 WETH notional · 3,000 USDC strike · 1,000 USDC premium · zero platform fee. Assumes full physical exercise when in the money, no exercise otherwise, and the same holders throughout. Exercise is the buyer’s choice. Total value includes separately claimed premium. This is asset value, not profit.</p>`;
  let payoffKind = "call";
  function renderPayoff() {
    const spot = Number($("#market-price").value);
    const total = 10 * Math.min(spot, 3000) + 1000;
    const hold = payoffKind === "call" ? 10 * spot : 30000;
    const difference = total - hold;
    const x = 55 + ((spot - 1500) / 3000) * 475;
    const y = 242 - (total / 45000) * 217;
    $(".hold-path").setAttribute(
      "d",
      payoffKind === "call" ? "M55 169.67L530 25" : "M55 97.33H530"
    );
    $(".price-guide").setAttribute("d", `M${x} 25V242`);
    $(".value-dot").setAttribute("cx", x);
    $(".value-dot").setAttribute("cy", y);
    $("#explorer-value").textContent = number(total);
    $("#explorer-difference").textContent = `${
      difference > 0 ? "+" : difference < 0 ? "−" : ""
    }${number(Math.abs(difference))} USDC`;
    $("#market-output").textContent = `${number(spot)} USDC`;
    $("#market-price").setAttribute(
      "aria-valuetext",
      `${number(spot)} USDC per WETH`
    );
    $("#payoff-takeaway").textContent =
      payoffKind === "call"
        ? spot > 3000
          ? "Above the strike, this model exchanges the WETH for USDC. The LP’s upside is capped."
          : "At or below the strike, this model leaves the WETH in the pool. Its market value still moves."
        : spot < 3000
        ? "Below the strike, this model buys WETH at 3,000 USDC. The received WETH is worth less at the market price."
        : "At or above the strike, this model leaves the USDC collateral in the pool. LPs also earn the premium.";
    $$("[data-payoff]").forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.payoff === payoffKind)
      )
    );
  }
  $$("[data-payoff]").forEach(
    (button) =>
      (button.onclick = () => {
        payoffKind = button.dataset.payoff;
        renderPayoff();
      })
  );
  $("#market-price").oninput = renderPayoff;
  renderPayoff();

  document.body.classList.add("guide-ready");
  requestAnimationFrame(followAnchor);
})();
