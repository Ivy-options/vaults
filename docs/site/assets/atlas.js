/* Input-driven examples use the documented quantities; no transactions are submitted. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const roman = [
    "I",
    "II",
    "III",
    "IV",
    "V",
    "VI",
    "VII",
    "VIII",
    "IX",
    "X",
    "XI",
  ];
  $$(".chapter-eyebrow").forEach(
    (e, i) =>
      (e.innerHTML = `LIBER ${roman[i]} <span>/ ${
        roman[$$(".chapter-eyebrow").length - 1]
      }</span>`)
  );
  $$(".nav-number").forEach((e) => {
    const n = Number(e.textContent);
    if (Number.isFinite(n)) e.textContent = n ? roman[n - 1] : "·";
  });
  $$(".interactive-example input, .interactive-example select").forEach(
    (e) => (e.disabled = false)
  );
  function consent() {
    const a = $("#consent-a").checked,
      b = $("#consent-b").checked,
      buyer = $("#consent-buyer").checked;
    const percent = (a ? 60 : 0) + (b ? 40 : 0);
    $(".ownership-a").classList.toggle("is-missing", !a);
    $(".ownership-b").classList.toggle("is-missing", !b);
    $(".ownership-bar").setAttribute(
      "aria-label",
      `${percent}% of current shares approve`
    );
    $("#consent-status").textContent = `${
      buyer ? "Buyer signed" : "Buyer signature missing"
    } · ${percent}% of current shares approve${
      buyer && percent === 100
        ? " · consent complete; funding and execution checks still apply"
        : " · consent incomplete"
    }`;
    const total = Number($("#unwind-refund").value);
    $("#refund-a").textContent = `${total * 0.6} USDC`;
    $("#refund-b").textContent = `${total * 0.4} USDC`;
    $("#refund-total").textContent = `${total} USDC`;
    $("#refund-note").textContent = total
      ? "Six-decimal USDC: 100000000 raw units. The executing caller supplies no refund tokens."
      : "Zero refund needs no funding. Buyer signature and all current-shareholder approvals are still required.";
  }
  ["#consent-a", "#consent-b", "#consent-buyer", "#unwind-refund"].forEach(
    (id) => $(id).addEventListener("change", consent)
  );
  consent();
  function fees() {
    const bps = Number($("#fee-rate").value),
      blocked = bps > 200,
      fee = (1000 * bps) / 10000;
    $("#fee-rate-output").textContent = `${bps} bps · ${bps / 100}%`;
    $(".fee-laboratory").classList.toggle("is-blocked", blocked);
    $("#fee-net").textContent = blocked
      ? "Not allocated"
      : `${1000 - fee} USDC`;
    $("#fee-treasury").textContent = blocked ? "Not allocated" : `${fee} USDC`;
    $("#fee-example-bar > span").style.width = `${blocked ? 0 : 100 - bps / 100}%`;
    $("#fee-example-bar > i").style.width = `${blocked ? 0 : bps / 100}%`;
    $("#fee-example-bar").setAttribute(
      "aria-label",
      blocked
        ? "Activation rejected; no premium allocation"
        : `${1000 - fee} USDC to LPs; ${fee} USDC to treasury`
    );
    $("#fee-status").textContent = blocked
      ? "Activation rejected: current fee exceeds the 200 bps creation-time cap."
      : "Rate is within the cap. Activation may proceed if all other checks pass.";
  }
  $("#fee-rate").addEventListener("input", fees);
  fees();
  function cashControls() {
    const flag = $("#cash-flag-demo").checked,
      publisher = $("#cash-publisher-demo").checked;
    $("#cash-switch-status").textContent = `${
      flag ? "Cash admissions enabled" : "Cash admissions disabled"
    } · ${publisher ? "Publisher authorized" : "No authorized publisher"}${
      flag && !publisher
        ? " · the flag alone does not provide settlement reports"
        : ""
    }. Existing positions keep their obligations.`;
  }
  ["#cash-flag-demo", "#cash-publisher-demo"].forEach((id) =>
    $(id).addEventListener("change", cashControls)
  );
  cashControls();
  const fmt = (n, d = 4) =>
    n.toLocaleString("en-US", { maximumFractionDigits: d });
  function cashAmounts() {
    const call = $("#cash-kind-demo").value === "call",
      price = Number($("#cash-price-demo").value),
      deposit = call ? 10 : 30000;
    const buyer = call
        ? (10 * Math.max(price - 3000, 0)) / price
        : 10 * Math.max(3000 - price, 0),
      pool = deposit - buyer,
      unit = call ? "WETH" : "USDC";
    $("#cash-price-output").textContent = `${fmt(price, 0)} USDC / WETH`;
    $("#cash-total-value").textContent = `${fmt(deposit)} ${unit}`;
    $("#cash-buyer-value").textContent = `${fmt(buyer)} ${unit}`;
    $("#cash-pool-value").textContent = `${fmt(pool)} ${unit}`;
    $("#cash-buyer-percent").textContent = `${fmt(buyer / deposit * 100, 2)}% of collateral`;
    $("#cash-pool-percent").textContent = `${fmt(pool / deposit * 100, 2)}% of collateral`;
    $("#cash-outcome-note").textContent = buyer === 0
      ? `No buyer payout at this price. All ${fmt(deposit)} ${unit} remains for shareholder claims.`
      : `Both allocations stay in ${unit} until claimed.`;
    $("#cash-buyer-bar").style.width = `${(buyer / deposit) * 100}%`;
    $(".cash-balance-bar").setAttribute(
      "aria-label",
      `Buyer reserve ${fmt(buyer)} ${unit}; residual pool ${fmt(pool)} ${unit}`
    );
    $("#cash-calculation").textContent = call
      ? `10 × max(${fmt(price, 0)} − 3,000, 0) / ${fmt(price, 0)} ≈ ${fmt(
          buyer
        )} WETH`
      : `10 × max(3,000 − ${fmt(price, 0)}, 0) = ${fmt(buyer)} USDC`;
  }
  $("#cash-kind-demo").addEventListener("change", cashAmounts);
  $("#cash-price-demo").addEventListener("input", cashAmounts);
  cashAmounts();
  $$('input[name="recommended-release"]').forEach((e) =>
    e.addEventListener("change", () => {
      const selected = $('input[name="recommended-release"]:checked').value;
      $$("[data-release]").forEach((node) => {
        const recommended = node.dataset.release === selected;
        node.classList.toggle("is-recommended", recommended);
        node.querySelector(".release-badge").textContent = recommended
          ? "Recommended"
          : "Available release";
      });
      $(
        "#release-status"
      ).textContent = `Recommended for new creation: Hub ${selected}. Existing position stays on Hub A.`;
    })
  );
})();
