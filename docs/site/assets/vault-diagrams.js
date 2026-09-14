/* Native HTML diagrams; no rendering library or build step required. */
(() => {
  // Shared, static container for custody diagrams. Quantities stay in HTML.
  function vaultBox(contents, caption = "", title = "Vault") {
    return `<div class="vault-box"><div class="vault-box-heading"><h3>${title}</h3>${
      caption ? `<span>${caption}</span>` : ""
    }</div>${contents}</div>`;
  }

  // Crop the approved artwork without altering it or repeating its printed labels.
  // Preserve the original Owner/LP; use the approved revision for Buyer/Bid master.
  function romanOperator(index) {
    const crops = [
      "24 76 477 580", // Owner with a wax tablet.
      "504 76 425 580", // LP with coins.
      "931 76 461 580", // Buyer with a signed scroll.
      "1394 76 533 580", // Bid master announcing the auction.
    ];
    const [x, y, width, height] = crops[index].split(" ");
    const artwork = "operator-portraits.webp"; // one sheet, drawn into the original 1942×809 box
    return `<svg class="roman-operator" viewBox="${crops[index]}" aria-hidden="true" focusable="false"><defs><clipPath id="operator-crop-${index}"><rect x="${x}" y="${y}" width="${width}" height="${height}" /></clipPath></defs><image href="assets/${artwork}" width="1942" height="809" clip-path="url(#operator-crop-${index})" /></svg>`;
  }

  function mountActorVault(target) {
    const host = document.createElement("div");
    host.className = "custody-atlas";
    host.setAttribute("role", "group");
    host.setAttribute(
      "aria-label",
      "One shared Hub coordinates calls to separate vaults, each holding its own tokens"
    );
    const vaults = [1, 2, 3]
      .map(
        (number) =>
          `<div class="vault-branch"><i class="branch-arrow" aria-hidden="true"></i>${vaultBox(
            '<div class="vault-method-row"><code>pull(...)</code><span>Receive tokens</span></div><div class="vault-method-row"><code>push(...)</code><span>Send tokens</span></div>',
            "Called by the Hub",
            `Vault ${number}`
          )}</div>`
      )
      .join("");
    host.innerHTML = `<div class="custody-composition multi-vault"><div class="hub-box"><h3>Ivy Vaults Hub</h3><p>Shared entry point</p><span>Validates and coordinates · No token custody</span></div><div class="box-connector hub-entry-link"><span>Calls</span><i aria-hidden="true"></i></div><div class="vault-collection">${vaults}</div></div><div class="plate-select" aria-label="Highlight an instruction route">${[
      "Owner",
      "LP",
      "Buyer",
      "Bid master",
    ]
      .map(
        (name, index) =>
          `<button type="button" data-route="${index}" aria-pressed="${
            index === 0
          }">${name}</button>`
      )
      .join(
        ""
      )}</div><ol class="actor-route" aria-label="Selected actor route"></ol><p class="vault-route-note" role="status"></p>`;
    const explanation = document.createElement("div");
    explanation.className = "actor-explanation";
    explanation.append(
      host.querySelector(".plate-select"),
      host.querySelector(".actor-route"),
      target.querySelector(".actor-lanes"),
      host.querySelector(".vault-route-note")
    );
    host.append(explanation);
    target.prepend(host);
    target.classList.add("box-enhanced");
    const routes = [
      [
        ["Owner", "Terms and auction instructions"],
        ["Hub", "Coordinates the vault"],
      ],
      [
        ["Hub.deposit", "(vaultId, amount)"],
        ["Vault.pull", "(token, from, amount)"],
      ],
      [
        ["Buyer", "Signs the bid"],
        ["Bid master", "Selects off-chain"],
        ["Hub", "Receives the selected bid"],
      ],
      [
        ["Bid master", "Submits the signed bid"],
        ["Hub", "Validates and activates"],
      ],
    ];
    const details = [...target.querySelector(".actor-lanes").children];
    const buttons = [...host.querySelectorAll("button[data-route]")];
    details.forEach((detail, index) => {
      detail.id = `actor-details-${index}`;
      buttons[index].id = `actor-selector-${index}`;
      buttons[index].setAttribute("aria-controls", detail.id);
      detail.setAttribute("role", "region");
      detail.setAttribute("aria-labelledby", buttons[index].id);
      const heading = document.createElement("div");
      heading.className = "operator-heading";
      const portrait = document.createElement("span");
      portrait.className = "operator-portrait";
      portrait.innerHTML = romanOperator(index);
      const title = document.createElement("div");
      title.append(
        detail.querySelector(".inscription"),
        detail.querySelector("h3")
      );
      heading.append(portrait, title);
      detail.prepend(heading);
    });
    function select(index) {
      details.forEach((detail, i) => {
        detail.hidden = i !== index;
      });
      host.dataset.route = String(index);
      host
        .querySelectorAll("button[data-route]")
        .forEach((button, i) =>
          button.setAttribute("aria-pressed", String(i === index))
        );
      host.querySelector(".actor-route").innerHTML = routes[index]
        .map(([name, action]) =>
          index === 1
            ? `<li><strong><code>${name}</code></strong><span><code>${action.replaceAll(
                ", ",
                ",<wbr> "
              )}</code></span></li>`
            : `<li><strong>${name}</strong><span>${action}</span></li>`
        )
        .join("");
      const note = host.querySelector(".vault-route-note");
      note.hidden = index !== 1;
      note.textContent =
        "Deposit calls can use the Hub or the vault directly; token approval targets the vault.";
    }
    host.querySelector(".plate-select").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) select(Number(button.dataset.route));
    });
    select(0);
  }

  // Custody categories only; the existing phase ledger owns permissions and rules.
  function mountLifecycle(root) {
    const host = document.createElement("div");
    host.className = "lifecycle-map";
    host.innerHTML = `<div class="custody-heading"><span class="inscription">ACCOUNTING WITHIN THE VAULT</span><label class="settled-example" hidden>Settlement illustration<select aria-label="Settlement illustration"><option value="physical">Physical exercise / expiry</option><option value="cash">Cash expiry</option><option value="unwind">Unwind with a refund</option></select></label></div><div class="custody-compartments"><div class="custody-backing"><span class="compartment-index" aria-hidden="true">I</span><h4></h4><p></p></div><div class="custody-premium"><span class="compartment-index" aria-hidden="true">II</span><h4></h4><p></p></div><div class="custody-buyer" hidden><span class="compartment-index" aria-hidden="true">III</span><h4>Buyer payout reserve</h4><p></p></div></div><p class="custody-note">Separate accounting budgets within the same vault.</p>`;
    root.querySelector(".phase-buttons").after(host);
    const states = [
      [
        "Deposited collateral",
        "Backing assets",
        "Premium & fees",
        "Not yet earned",
      ],
      [
        "Committed collateral",
        "Fixed auction balance",
        "Premium & fees",
        "Not yet earned",
      ],
      [
        "Backing & proceeds",
        "Changes with exercise",
        "Premium & fee reserves",
        "Unpaid earned allocations",
      ],
      [
        "Shareholder pool",
        "Unreserved assets",
        "Premium & fee reserves",
        "Unpaid earned allocations",
      ],
    ];
    const choice = host.querySelector("select");
    function sync() {
      const phase = Number(root.dataset.phase || 0),
        state = states[phase];
      host.dataset.phase = String(phase);
      host.querySelector(".custody-backing h4").textContent = state[0];
      host.querySelector(".custody-backing p").textContent = state[1];
      host.querySelector(".custody-premium h4").textContent = state[2];
      host.querySelector(".custody-premium p").textContent = state[3];
      host
        .querySelector(".custody-premium")
        .classList.toggle("not-earned", phase < 2);
      host.querySelector(".settled-example").hidden = phase !== 3;
      const outcome = phase === 3 ? choice.value : "physical",
        reserve = host.querySelector(".custody-buyer");
      reserve.hidden = outcome === "physical";
      host
        .querySelector(".custody-compartments")
        .classList.toggle("with-buyer-reserve", outcome !== "physical");
      reserve.querySelector("p").textContent =
        outcome === "cash"
          ? "Cash payout · only if positive and unpaid"
          : "Funded unwind refund · only while unpaid";
    }
    choice.addEventListener("change", sync);
    root.addEventListener("phase-state", sync);
    sync();
  }

  const actors = document.querySelector(".actor-map");
  if (actors) mountActorVault(actors);

  const lifecycle = document.getElementById("visual-lifecycle");
  if (lifecycle) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        mountLifecycle(lifecycle);
      },
      { rootMargin: "160px" }
    );
    observer.observe(lifecycle);
  }

  // Optional visual layer. The existing HTML exchange is the fallback and data source.
  const root = document.getElementById("visual-collateral");
  if (root) {
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        watcher.disconnect();
        mountScene(root);
      },
      { rootMargin: "160px" }
    );
    watcher.observe(root);
  }

  function mountScene(root) {
    const fallback = root.querySelector(".transfer-scene");
    const settings = document.createElement("div");
    settings.className = "exercise-settings";
    settings.append(root.querySelector(".stage-top"));
    const terms = document.createElement("dl");
    terms.className = "exercise-terms";
    terms.innerHTML = "<dt>Strike</dt><dd>3,000 USDC / WETH</dd>";
    settings.append(terms, root.querySelector(".exercise-controls"));
    settings.querySelector(".stage-label").textContent = "EXERCISE EXAMPLE";
    root.querySelector(".token-key").remove();
    root.prepend(settings);

    const host = document.createElement("div");
    host.className = "token-theatre box-exchange exercise-result";
    host.innerHTML = `<div class="exercise-transfers"><div><span class="transfer-label">Caller <span aria-hidden="true">→</span> Vault</span><strong class="scene-payment"></strong><small>Payment in</small></div><div><span class="transfer-label">Vault <span aria-hidden="true">→</span> Recipient</span><strong class="scene-delivery"></strong><small>Delivery out</small></div></div>${vaultBox(
      '<table class="exercise-balances"><caption class="sr-only">Vault token balances before and after this illustrative exercise</caption><thead><tr><th scope="col">Token</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody><tr class="balance-weth"><th scope="row"><span class="box-token weth-symbol" aria-hidden="true">◇</span> WETH</th><td><strong class="before-weth"></strong><span class="balance-track" aria-hidden="true"><i class="before-weth-bar"></i></span></td><td><strong class="held-weth"></strong><span class="balance-track" aria-hidden="true"><i class="after-weth-bar"></i></span></td></tr><tr class="balance-usdc"><th scope="row"><span class="box-token usdc-symbol" aria-hidden="true">$</span> USDC</th><td><strong class="before-usdc"></strong><span class="balance-track" aria-hidden="true"><i class="before-usdc-bar"></i></span></td><td><strong class="held-usdc"></strong><span class="balance-track" aria-hidden="true"><i class="after-usdc-bar"></i></span></td></tr></tbody></table>',
      "Token balances"
    )}<p class="exercise-summary" role="status"></p><p class="scene-caption">The caller funds the payment; the <a href="#execution-permissions">configured recipient</a> receives delivery.</p>`;
    fallback.before(host);
    function sync() {
      const call = root.dataset.option === "call";
      const amount = Number(root.dataset.amount || 0);
      const beforeWeth = call ? 10 : 0;
      const beforeUsdc = call ? 0 : 30000;
      const afterWeth = call ? 10 - amount : amount;
      const afterUsdc = call ? amount * 3000 : 30000 - amount * 3000;
      host.querySelector(".scene-payment").textContent =
        root.querySelector("#incoming-amount").textContent;
      host.querySelector(".scene-delivery").textContent =
        root.querySelector("#outgoing-amount").textContent;
      for (const [selector, value] of [
        [".before-weth", beforeWeth], [".before-usdc", beforeUsdc],
        [".held-weth", afterWeth], [".held-usdc", afterUsdc],
      ]) host.querySelector(selector).textContent = value.toLocaleString("en-US");
      for (const [selector, percent] of [
        [".before-weth-bar", beforeWeth * 10],
        [".after-weth-bar", afterWeth * 10],
        [".before-usdc-bar", beforeUsdc / 300],
        [".after-usdc-bar", afterUsdc / 300],
      ]) host.querySelector(selector).style.width = `${percent}%`;
      host.querySelector(".exercise-summary").textContent = amount === 0
        ? "No exercise selected. The vault balances stay unchanged."
        : amount === 10
          ? "Full exercise. The vault is finalized."
          : `Partial exercise. ${10 - amount} WETH of option notional remains.`;
      host.classList.toggle("zero-transfer", amount === 0);
    }
    root.addEventListener("exchange-state", sync);
    sync();
    root.classList.add("box-delivery", "exercise-lab");
    root.dataset.sceneReady = "true";
  }
})();
