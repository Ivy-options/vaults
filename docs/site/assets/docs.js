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

  // LP total value including earned premium (quote terms) as a function of spot, for the fully-in-the-money case.
  // call: D*min(S,K) + P (hold = D*S).  put: N*min(S,K) + P (hold = C).
  function drawPayoff(svg, o) {
    var W = 420,
      H = 250,
      L = 52,
      R = 16,
      T = 18,
      B = 34;
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
      '" font-family="JetBrains Mono, monospace" font-size="10.5" fill="' +
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
        '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" fill="' +
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
        '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="' +
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
      '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="' +
      faint +
      '" letter-spacing="1">SPOT →</text>';
    svg.innerHTML = h;
  }

  function params() {
    var kind = $("kind").value;
    var dep = parseFloat($("dep").value);
    var K = parseFloat($("strike").value);
    var p = parseFloat($("prem").value);
    var S = parseFloat($("spot").value);
    var N = kind === "call" ? dep : K > 0 ? dep / K : 0;
    return { kind: kind, D: dep, C: dep, K: K, p: p, S: S, N: N, P: p * N };
  }

  function render() {
    var o = params();
    $("depLabel").textContent =
      o.kind === "call" ? "Deposit (WETH)" : "Deposit (USDC)";
    var valid =
      [o.D, o.K, o.p, o.S].every(Number.isFinite) &&
      o.D > 0 &&
      o.K > 0 &&
      o.S > 0 &&
      o.p >= 0;
    $("calcError").hidden = valid;
    $("calcError").textContent = valid
      ? ""
      : "Enter a positive deposit, strike and expiry price, and a non-negative premium.";
    if (!valid) {
      $("rows").innerHTML = "";
      $("calcChart").innerHTML = "";
      $("notional").textContent = "Unavailable";
      $("premTotal").textContent = "Unavailable";
      $("calcNote").textContent = "";
      return;
    }
    var rows;
    if (o.kind === "call") {
      var payoutCall = o.S > o.K ? (o.N * (o.S - o.K)) / o.S : 0;
      rows = [
        ["Not exercised", o.D, o.P, "pays premium only"],
        [
          "Physical, fully exercised",
          0,
          o.D * o.K + o.P,
          "pays " + fmt(o.D * o.K, 2) + " USDC, takes " + fmt(o.D, 6) + " WETH",
        ],
        [
          "Cash at finalized expiry price",
          o.D - payoutCall,
          o.P,
          payoutCall > 0
            ? "receives " + fmt(payoutCall, 6) + " WETH"
            : "out of the money, receives 0",
        ],
      ];
      $("calcNote").textContent =
        "Cash payout = remaining × (spot − strike) / spot, in WETH.";
    } else {
      var payoutPut = o.S < o.K ? o.N * (o.K - o.S) : 0;
      rows = [
        ["Not exercised", 0, o.C + o.P, "pays premium only"],
        [
          "Physical, fully exercised",
          o.N,
          o.C - o.N * o.K + o.P,
          "delivers " +
            fmt(o.N, 6) +
            " WETH, takes " +
            fmt(o.N * o.K, 2) +
            " USDC",
        ],
        [
          "Cash at finalized expiry price",
          0,
          o.C - payoutPut + o.P,
          payoutPut > 0
            ? "receives " + fmt(payoutPut, 2) + " USDC"
            : "out of the money, receives 0",
        ],
      ];
      $("calcNote").textContent =
        "Cash payout = remaining × (strike − spot), in USDC.";
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
  ["kind", "dep", "strike", "prem", "spot"].forEach(function (id) {
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
