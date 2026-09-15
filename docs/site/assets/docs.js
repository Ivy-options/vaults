(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var fmt = function (x, d) {
    if (!isFinite(x)) return "–";
    return x.toLocaleString(undefined, {
      maximumFractionDigits: d,
      minimumFractionDigits: 0,
    });
  };
  var css = function (name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
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
    var kind = $("kind").value;
    var dep = parseFloat($("dep").value);
    var K = parseFloat($("strike").value);
    var p = parseFloat($("prem").value);
    var days = parseFloat($("days").value);
    var entryPrice = parseFloat($("entryPrice").value);
    var N = kind === "call" ? dep : K > 0 ? dep / K : 0;
    return { kind: kind, D: dep, C: dep, K: K, p: p, N: N, P: p * N, days: days, entryPrice: entryPrice };
  }

  function render() {
    var o = params();
    $("depLabel").textContent =
      o.kind === "call" ? "Deposit (WETH)" : "Deposit (USDC)";
    $("entryPriceField").hidden = o.kind !== "call";
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
      $(field[0]).ariaInvalid = String(!field[1]);
    });
    var invalidField = fieldErrors.find(function (field) { return !field[1]; });
    $("calcError").hidden = valid;
    $("calcError").textContent = valid
      ? ""
      : invalidField ? invalidField[2] : "These values exceed the calculator's numeric range. Use smaller amounts.";
    if (!valid) {
      $("rows").innerHTML = "";
      $("calcChart").innerHTML = "";
      $("notional").textContent = "Unavailable";
      $("premTotal").textContent = "Unavailable";
      $("premiumYield").textContent = "Unavailable";
      $("premiumApr").textContent = "Unavailable";
      $("calcNote").textContent = "";
      return;
    }
    $("premiumYield").textContent = fmt(premiumYield, 2) + "%";
    $("premiumApr").textContent = fmt(premiumApr, 2) + "%";
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
      $("calcNote").textContent =
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
      $("calcNote").textContent =
        "Physical put: USDC paid at the strike leaves the pool; WETH delivered by the buyer stays for LPs. Premium is claimed separately.";
    }
    $("notional").textContent = fmt(o.N, 6) + " WETH";
    $("premTotal").textContent = fmt(o.P, 2) + " USDC";
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
    $("rows").innerHTML = html;
    if (o.K > 0) drawPayoff($("calcChart"), o);
  }

  function redrawAll() {
    render();
  }
  window.addEventListener("resize", redrawAll);
  ["kind", "dep", "strike", "prem", "days", "entryPrice"].forEach(function (id) {
    $(id).addEventListener("input", render);
  });
  redrawAll();
  labelTheme();
  themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ivy-theme", next);
    } catch (e) {}
    labelTheme();
    redrawAll();
  });
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", function () {
        labelTheme();
        redrawAll();
      });
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
