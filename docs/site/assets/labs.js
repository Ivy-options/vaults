/* Interactive examples used inside map cards. Each function initialises one widget inside `scope`. */
(() => {
  const $ = (s, scope) => scope.querySelector(s);
  const $$ = (s, scope) => [...scope.querySelectorAll(s)];
  const byId = (id, scope) => scope.querySelector(`#${CSS.escape(id)}`);
  const enable = (scope) => $$("input[disabled], select[disabled]", scope).forEach((el) => (el.disabled = false));

  function fees(scope) {                     // from atlas.js fees()
    enable(scope);
    const rate = byId("fee-rate", scope), out = byId("fee-rate-output", scope), net = byId("fee-net", scope), treasury = byId("fee-treasury", scope), bar = byId("fee-example-bar", scope);
    const sync = () => {
      const bps = Number(rate.value), fee = (1000 * bps) / 10000;
      out.textContent = `${bps.toLocaleString("en-US")} bps · ${bps / 100}%`;
      net.textContent = `${1000 - fee} USDC`;
      treasury.textContent = `${fee} USDC`;
      if (bar) { bar.children[0].style.width = `${100 - bps / 100}%`; bar.children[1].style.width = `${bps / 100}%`; bar.setAttribute("aria-label", `${1000 - fee} USDC to LPs; ${fee} USDC to treasury`); }
    };
    rate.addEventListener("input", sync);
    sync();
  }

  function payoff(scope) {                   // from docs.js: drawPayoff, params, render, redrawAll
    const $id = (id) => byId(id, scope);
    const fmt = function (x, d) {
      if (!isFinite(x)) return "–";
      return x.toLocaleString(undefined, {
        maximumFractionDigits: d,
        minimumFractionDigits: 0,
      });
    };
    const css = function (name) {
      return getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    };

    // LP value with premium (quote terms), assuming full physical exercise when
    // in the money and no exercise otherwise. Market price only values the tokens.
    // call: D*min(S,K) + P (hold = D*S).  put: N*min(S,K) + P (hold = C).
    function drawPayoff(svg, o) {
      var W = Math.max(260, svg.clientWidth || 420),
        H = 250,
        L = 52,
        R = 28,
        T = 18,
        B = 34;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      var K = o.K,
        P = o.P;
      var xs = [K * 0.5, K * 1.5];
      var vault = function (S) {
        return o.kind === "call"
          ? o.D * Math.min(S, K) + P
          : o.N * Math.min(S, K) + P;
      };
      var hold = function (S) {
        return o.kind === "call" ? o.D * S : o.C;
      };
      var ys = [];
      [xs[0], K, xs[1]].forEach(function (S) {
        ys.push(vault(S));
        ys.push(hold(S));
      });
      var y0 = 0,
        y1 = Math.max.apply(null, ys) * 1.08;
      var X = function (S) {
        return L + ((S - xs[0]) / (xs[1] - xs[0])) * (W - L - R);
      };
      var Y = function (v) {
        return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      };
      var ink = css("--ink"),
        faint = css("--faint"),
        line = css("--line-strong"),
        accent = css("--accent");
      var pts = function (f) {
        var s = [];
        for (var i = 0; i <= 60; i++) {
          var S = xs[0] + ((xs[1] - xs[0]) * i) / 60;
          s.push(X(S).toFixed(1) + "," + Y(f(S)).toFixed(1));
        }
        return s.join(" ");
      };
      var ticks = [xs[0], K, xs[1]];
      var yTicks = [0, y1 / 2, y1];
      var h = "";
      // grid
      yTicks.forEach(function (v) {
        h +=
          '<line x1="' +
          L +
          '" x2="' +
          (W - R) +
          '" y1="' +
          Y(v).toFixed(1) +
          '" y2="' +
          Y(v).toFixed(1) +
          '" stroke="' +
          line +
          '" stroke-width="1"/>';
      });
      // strike marker
      h +=
        '<line x1="' +
        X(K).toFixed(1) +
        '" x2="' +
        X(K).toFixed(1) +
        '" y1="' +
        T +
        '" y2="' +
        (H - B) +
        '" stroke="' +
        accent +
        '" stroke-width="1" stroke-dasharray="2 3"/>';
      // hold line
      h +=
        '<polyline points="' +
        pts(hold) +
        '" fill="none" stroke="' +
        faint +
        '" stroke-width="1.2" stroke-dasharray="4 4"/>';
      // vault line
      h +=
        '<polyline points="' +
        pts(vault) +
        '" fill="none" stroke="' +
        ink +
        '" stroke-width="2"/>';
      // premium bracket at left edge
      var yb0 = Y(vault(xs[0]) - P),
        yb1 = Y(vault(xs[0]));
      h +=
        '<line x1="' +
        (L + 6) +
        '" x2="' +
        (L + 6) +
        '" y1="' +
        yb0.toFixed(1) +
        '" y2="' +
        yb1.toFixed(1) +
        '" stroke="' +
        accent +
        '" stroke-width="2"/>';
      h +=
        '<text x="' +
        (L + 6) +
        '" y="' +
        (Math.max(yb0, yb1) + 12).toFixed(1) +
        '" font-family="JetBrains Mono, monospace" font-size="12" fill="' +
        accent +
        '">P = ' +
        fmt(P, 0) +
        "</text>";
      // axes labels
      ticks.forEach(function (S) {
        h +=
          '<text x="' +
          X(S).toFixed(1) +
          '" y="' +
          (H - 12) +
          '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12" fill="' +
          faint +
          '">' +
          (S === K ? "K " : "") +
          fmt(S, 0) +
          "</text>";
      });
      yTicks.forEach(function (v) {
        h +=
          '<text x="' +
          (L - 8) +
          '" y="' +
          (Y(v) + 3).toFixed(1) +
          '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="12" fill="' +
          faint +
          '">' +
          (v >= 1000 ? fmt(v / 1000, 1) + "k" : fmt(v, 0)) +
          "</text>";
      });
      h +=
        '<text x="' +
        (W - R) +
        '" y="' +
        (T - 6) +
        '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="12" fill="' +
        faint +
        '" letter-spacing="1">SPOT →</text>';
      svg.innerHTML = h;
    }

    function params() {
      var kind = $id("kind").value;
      var dep = parseFloat($id("dep").value);
      var K = parseFloat($id("strike").value);
      var p = parseFloat($id("prem").value);
      var days = parseFloat($id("days").value);
      var entryPrice = parseFloat($id("entryPrice").value);
      var N = kind === "call" ? dep : K > 0 ? dep / K : 0;
      return { kind: kind, D: dep, C: dep, K: K, p: p, N: N, P: p * N, days: days, entryPrice: entryPrice };
    }

    function render() {
      var o = params();
      $id("depLabel").textContent =
        o.kind === "call" ? "Deposit (WETH)" : "Deposit (USDC)";
      $id("entryPriceField").hidden = o.kind !== "call";
      var initialValue = o.kind === "call" ? o.D * o.entryPrice : o.C;
      var premiumYield = o.P / initialValue * 100;
      var premiumApr = premiumYield * 365 / o.days;
      var valid =
        [o.D, o.K, o.p, o.N, o.P, o.days, initialValue, premiumYield, premiumApr].every(Number.isFinite) &&
        o.D > 0 &&
        o.K > 0 &&
        o.p >= 0 &&
        o.days > 0 &&
        initialValue > 0;
      var fieldErrors = [
        ["dep", Number.isFinite(o.D) && o.D > 0, "Enter a deposit greater than zero."],
        ["strike", Number.isFinite(o.K) && o.K > 0, "Enter a strike price greater than zero."],
        ["prem", Number.isFinite(o.p) && o.p >= 0, "Enter a premium of zero or more."],
        ["days", Number.isFinite(o.days) && o.days > 0, "Enter more than zero days committed."],
        ["entryPrice", o.kind !== "call" || (Number.isFinite(o.entryPrice) && o.entryPrice > 0), "Enter a WETH price greater than zero."],
      ];
      fieldErrors.forEach(function (field) {
        $id(field[0]).ariaInvalid = String(!field[1]);
      });
      var invalidField = fieldErrors.find(function (field) { return !field[1]; });
      $id("calcError").hidden = valid;
      $id("calcError").textContent = valid
        ? ""
        : invalidField ? invalidField[2] : "These values exceed the calculator's numeric range. Use smaller amounts.";
      if (!valid) {
        $id("rows").innerHTML = "";
        $id("calcChart").innerHTML = "";
        $id("notional").textContent = "Unavailable";
        $id("premTotal").textContent = "Unavailable";
        $id("premiumYield").textContent = "Unavailable";
        $id("premiumApr").textContent = "Unavailable";
        $id("calcNote").textContent = "";
        return;
      }
      $id("premiumYield").textContent = fmt(premiumYield, 2) + "%";
      $id("premiumApr").textContent = fmt(premiumApr, 2) + "%";
      var rows;
      if (o.kind === "call") {
        rows = [
          ["Expired without exercise", o.D, o.P, "pays premium only"],
          [
            "Fully exercised",
            0,
            o.D * o.K + o.P,
            "pays " + fmt(o.D * o.K, 2) + " USDC, takes " + fmt(o.D, 6) + " WETH",
          ],
        ];
        $id("calcNote").textContent =
          "Physical call: exercised WETH leaves the pool; USDC paid at the strike stays for LPs. Premium is claimed separately.";
      } else {
        rows = [
          ["Expired without exercise", 0, o.C + o.P, "pays premium only"],
          [
            "Fully exercised",
            o.N,
            o.C - o.N * o.K + o.P,
            "delivers " +
              fmt(o.N, 6) +
              " WETH, takes " +
              fmt(o.N * o.K, 2) +
              " USDC",
          ],
        ];
        $id("calcNote").textContent =
          "Physical put: USDC paid at the strike leaves the pool; WETH delivered by the buyer stays for LPs. Premium is claimed separately.";
      }
      $id("notional").textContent = fmt(o.N, 6) + " WETH";
      $id("premTotal").textContent = fmt(o.P, 2) + " USDC";
      var html = "";
      for (var i = 0; i < rows.length; i++) {
        html +=
          '<tr><td class="k">' +
          rows[i][0] +
          '</td><td class="num"><span class="big">' +
          fmt(rows[i][1], 6) +
          '</span></td><td class="num"><span class="big">' +
          fmt(rows[i][2], 2) +
          '</span></td><td class="mm">' +
          rows[i][3] +
          "</td></tr>";
      }
      $id("rows").innerHTML = html;
      if (o.K > 0) drawPayoff($id("calcChart"), o);
    }

    function redrawAll() {
      render();
    }
    window.addEventListener("resize", redrawAll);
    ["kind", "dep", "strike", "prem", "days", "entryPrice"].forEach(function (id) {
      $id(id).addEventListener("input", render);
    });
    redrawAll();
    const mapEl = document.querySelector("#map");
    if (mapEl) mapEl.addEventListener("map:theme", redrawAll);
  }

  function cashAmounts(scope) {              // from atlas.js cashAmounts()
    enable(scope);
    const fmt = (n, d = 4) =>
      n.toLocaleString("en-US", { maximumFractionDigits: d });
    const sync = () => {
      const call = byId("cash-kind-demo", scope).value === "call",
        price = Number(byId("cash-price-demo", scope).value),
        deposit = call ? 10 : 30000;
      const buyer = call
          ? (10 * Math.max(price - 3000, 0)) / price
          : 10 * Math.max(3000 - price, 0),
        pool = deposit - buyer,
        unit = call ? "WETH" : "USDC";
      byId("cash-price-output", scope).textContent = `${fmt(price, 0)} USDC / WETH`;
      byId("cash-total-value", scope).textContent = `${fmt(deposit)} ${unit}`;
      byId("cash-buyer-value", scope).textContent = `${fmt(buyer)} ${unit}`;
      byId("cash-pool-value", scope).textContent = `${fmt(pool)} ${unit}`;
      byId("cash-buyer-percent", scope).textContent = `${fmt(buyer / deposit * 100, 2)}% of collateral`;
      byId("cash-pool-percent", scope).textContent = `${fmt(pool / deposit * 100, 2)}% of collateral`;
      byId("cash-outcome-note", scope).textContent = buyer === 0
        ? `No buyer payout at this price. All ${fmt(deposit)} ${unit} remains for shareholder claims.`
        : `Both allocations stay in ${unit} until claimed.`;
      byId("cash-buyer-bar", scope).style.width = `${(buyer / deposit) * 100}%`;
      $(".cash-balance-bar", scope).setAttribute(
        "aria-label",
        `Buyer reserve ${fmt(buyer)} ${unit}; residual pool ${fmt(pool)} ${unit}`
      );
      byId("cash-calculation", scope).textContent = call
        ? `10 × max(${fmt(price, 0)} − 3,000, 0) / ${fmt(price, 0)} ≈ ${fmt(
            buyer
          )} WETH`
        : `10 × max(3,000 − ${fmt(price, 0)}, 0) = ${fmt(buyer)} USDC`;
    };
    byId("cash-kind-demo", scope).addEventListener("change", sync);
    byId("cash-price-demo", scope).addEventListener("input", sync);
    sync();
  }

  function consent(scope) {                  // from atlas.js consent()
    enable(scope);
    const sync = () => {
      const a = byId("consent-a", scope).checked,
        b = byId("consent-b", scope).checked,
        buyer = byId("consent-buyer", scope).checked;
      const percent = (a ? 60 : 0) + (b ? 40 : 0);
      $(".ownership-a", scope).classList.toggle("is-missing", !a);
      $(".ownership-b", scope).classList.toggle("is-missing", !b);
      $(".ownership-bar", scope).setAttribute(
        "aria-label",
        `${percent}% of current shares approve`
      );
      byId("consent-status", scope).textContent = `${
        buyer ? "Buyer signed" : "Buyer signature missing"
      } · ${percent}% of current shares approve${
        buyer && percent === 100
          ? " · consent complete; funding and execution checks still apply"
          : " · consent incomplete"
      }`;
      const total = Number(byId("unwind-refund", scope).value);
      byId("refund-a", scope).textContent = `${total * 0.6} USDC`;
      byId("refund-b", scope).textContent = `${total * 0.4} USDC`;
      byId("refund-total", scope).textContent = `${total} USDC`;
      byId("refund-note", scope).textContent = total
        ? "A 100 USDC refund is 100000000 raw units when USDC has six decimal places. The LPs fund it before execution; the caller who executes the agreement does not supply it."
        : "Zero refund needs no funding. Buyer signature and all current-shareholder approvals are still required.";
    };
    ["consent-a", "consent-b", "consent-buyer", "unwind-refund"].forEach(
      (id) => byId(id, scope).addEventListener("change", sync)
    );
    sync();
  }

  function releases(scope) {                 // from atlas.js recommended-release radios
    enable(scope);
    $$('input[name="recommended-release"]', scope).forEach((e) =>
      e.addEventListener("change", () => {
        const selected = $('input[name="recommended-release"]:checked', scope).value;
        $$("[data-release]", scope).forEach((node) => {
          const recommended = node.dataset.release === selected;
          node.classList.toggle("is-recommended", recommended);
          node.querySelector(".release-badge").textContent = recommended
            ? "Recommended"
            : "Available release";
        });
        byId(
          "release-status",
          scope
        ).textContent = `Recommended for new creation: Hub ${selected}. Existing position stays on Hub A.`;
      })
    );
  }

  function custody(scope) {                  // from vault-diagrams.js mountLifecycle(): a phase <select name="phase"> drives the labels
    const phase = $('select[name="phase"]', scope), example = $(".settled-example", scope), choice = example && $("select", example);
    const states = [
      ["Deposited collateral", "The vault's current balance of the chosen collateral token.", "Premium & fees", "Empty: no buyer payment has been collected.", true],
      ["Committed collateral", "The collateral balance committed to this auction.", "Premium & fees", "Empty: no buyer payment has been collected.", true],
      ["Backing & proceeds", "Remaining backing assets, plus any tokens received from physical exercise.", "Premium & fee reserves", "Premium owed to LPs and fees owed to the treasury that have not yet been paid.", false],
      ["Shareholder pool", "Remaining collateral and exercise proceeds after unpaid obligations are set aside.", "Premium & fee reserves", "Premium owed to LPs and fees owed to the treasury that have not yet been paid.", false],
    ];
    const reserves = { physical: null, cash: "Any cash-expiry payoff still owed to the buyer.", unwind: "The refund contributed separately by LPs and set aside for the buyer." };
    const sync = () => {
      const i = Number(phase.value), s = states[i];
      $(".custody-backing h4", scope).textContent = s[0]; $(".custody-backing p", scope).textContent = s[1];
      $(".custody-premium h4", scope).textContent = s[2]; $(".custody-premium p", scope).textContent = s[3];
      $(".custody-premium", scope).classList.toggle("not-earned", s[4]);
      if (example) example.hidden = i !== 3;
      const buyer = $(".custody-buyer", scope);
      const text = i === 3 && choice ? reserves[choice.value] : null;
      buyer.hidden = !text;
      if (text) $("p", buyer).textContent = text;
    };
    phase.addEventListener("change", sync); choice?.addEventListener("change", sync);
    sync();
  }

  function actorRoutes(scope) {              // from vault-diagrams.js mountActorVault(): routes[] and the LP note
    const routes = [
      [["Owner", "Terms and auction instructions"], ["Hub", "Coordinates the vault"]],
      [["Hub.deposit", "(vaultId, amount)"], ["Vault.pull", "(token, from, amount)"]],
      [["Market maker", "Offers premium and terms"], ["Bid master", "Selects off-chain"], ["Hub", "Collects premium and activates"]],
      [["Bid master", "Submits the signed bid"], ["Hub", "Validates and activates"]],
    ];
    const list = $(".actor-route", scope), note = $(".vault-route-note", scope);
    const pick = (i) => {
      $$("[data-route]", scope).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.route) === i)));
      list.innerHTML = routes[i].map(([a, b]) => `<li><strong>${i === 1 ? `<code>${a}</code>` : a}</strong><span>${b}</span></li>`).join("");
      if (note) note.textContent = i === 1 ? "Deposit calls can use the Hub or the vault directly; token approval targets the vault." : "";
    };
    $$("[data-route]", scope).forEach((b) => b.addEventListener("click", () => pick(Number(b.dataset.route))));
    pick(0);
  }

  const LABS = { fees, payoff, cashAmounts, consent, releases, custody, actorRoutes: actorRoutes, "actor-routes": actorRoutes };
  function mountAll(root) { $$("[data-lab]", root).forEach((el) => { const fn = LABS[el.dataset.lab]; if (fn && !el.dataset.mounted) { el.dataset.mounted = "1"; fn(el); } }); }
  window.IvyLabs = { ...LABS, mountAll };
})();
