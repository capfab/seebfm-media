// Builds one segment of SPEC into a 1920 x 1080 container and returns its timeline (the segment's own length) and its
// clips. The film (film.html) nests every segment's timeline in one master timeline and seeks it frame by frame; the
// slideshow (slides.html) plays a segment's timeline when its slide is shown.
window.EDIT = (function () {
  const MODEL = { see: "var(--see)", bfm0: "var(--bfm0)", level: "var(--level)", noscan: "var(--noscan)", student: "var(--student)" };
  const px = v => v + "px";
  function h(tag, cls, html, style) {
    const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; if (style) Object.assign(e.style, style); return e;
  }
  // fade an element in at t0 and out before t1 (when t1 is inside the segment)
  function span(tl, e, t0, t1, D, f = 0.3) {
    gsap.set(e, { opacity: t0 > 0 ? 0 : 1 });
    if (t0 > 0) tl.to(e, { opacity: 1, duration: f }, t0);
    if (t1 < D) tl.to(e, { opacity: 0, duration: f }, t1 - f);
  }

  function shots(seg, root, tl, mode, vids) {
    const D = seg.dur;
    seg.shots.forEach(s => {
      const slot = (window.SLOTS || {})[s.slot] || { ok: false, label: s.slot };
      const [x, y, w, hh] = s.box, t0 = s.t0 ?? 0, t1 = s.t1 ?? D;
      const div = h("div", "shot " + (s.full ? "full" : "framed"), null, { left: px(x), top: px(y), width: px(w), height: px(hh) });
      if (slot.ok) {
        const src = mode === "film" ? slot.proxy : slot.src;
        if (/\.png$/.test(src)) { const im = h("img"); im.src = src; div.appendChild(im); }
        else {
          const v = h("video"); v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = src; div.appendChild(v);
          vids.push({ v, t0: t0 + (s.lag || 0), t1, inpt: s.in || 0, rate: s.rate || 1, last: !!s.last, dur: slot.dur });
        }
      } else {
        div.appendChild(h("div", "ph", `<div class="pk">${slot.label}</div><div class="pv">placeholder: this clip is not rendered yet</div>`));
      }
      root.appendChild(div);
      // a shot fades in over the one before it; one that is followed in the same box holds until the next has faded in
      const fin = s.fade ?? (t0 > 0 ? 0.25 : 0);
      gsap.set(div, { opacity: t0 > 0 ? 0 : 1 });
      if (t0 > 0) tl.to(div, { opacity: 1, duration: fin }, t0);
      if (t1 < D) {
        const next = seg.shots.find(o => o !== s && o.box.join() === s.box.join() && Math.abs((o.t0 ?? 0) - t1) <= 0.5);
        if (next) tl.set(div, { opacity: 0 }, (next.t0 ?? 0) + (next.fade ?? 0.25) + 0.02);
        else tl.to(div, { opacity: 0, duration: 0.25 }, t1 - 0.25);
      }
    });
  }

  function item(it, seg, root, tl) {
    const D = seg.dur, t0 = it.t0 ?? 0, t1 = it.t1 ?? D;
    let e;
    switch (it.type) {
      case "divider": e = h("div", null, null, { position: "absolute", left: px(it.x - 2), top: 0, width: "4px", height: "1080px", background: "var(--studio)" }); break;
      case "dim": e = h("div", "dim"); if (it.a) e.style.background = `rgba(214, 210, 198, ${it.a})`; break;
      case "tag":
        e = h("div", "tag", (it.model ? `<i style="background:${MODEL[it.model]}"></i>` : "") + it.text, { left: px(it.x), top: px(it.y) });
        if (!it.model) e.style.paddingLeft = "18px"; break;
      case "chip":
        e = h("div", "chip", `<span class="p">prompt</span>${it.text}`);
        if (it.x != null) e.style.left = px(it.x); break;
      case "badge": e = h("div", "badge", "Simulation · 1x"); break;
      case "key": e = h("div", "key", `<i style="background:${it.color}"></i>${it.text}`, { left: px(it.x), top: px(it.y) }); break;
      case "lower":
        e = h("div", "lower", `<div class="n">${it.n}</div><div><div class="t">${it.t}</div>${it.s ? `<div class="s">${it.s}</div>` : ""}</div>`); break;
      case "statement":
        e = h("div", "statement" + (it.small ? " small" : ""), `<span>${it.text}</span>`, { top: px(it.y) }); break;
      case "typed": {
        e = h("div", "typed", `<span class="k">${it.k}</span><span class="tx"></span><span class="c"></span>`, { left: px(it.x), top: px(it.y) });
        const tx = e.querySelector(".tx"), st = { n: 0 }, full = it.text;
        tl.set(tx, { textContent: "" }, 0).to(st, { n: full.length, duration: full.length / (it.cps || 16), ease: "none",
          onUpdate: () => { tx.textContent = full.slice(0, Math.round(st.n)); } }, t0 + 0.25);
        break;
      }
      case "zmerge": {
        // the three prompt kinds come together into one latent prompt
        e = h("div", null, null, { position: "absolute", inset: "0" });
        const cards = it.labels.map((l, i) => { const c = h("div", "typed", `<span class="k">${l}</span>`, { left: px(560 + i * 300), top: "470px" }); e.appendChild(c); return c; });
        const z = h("div", "zchip", "z", { left: "880px", top: "440px", width: "160px", height: "160px" }); e.appendChild(z);
        const cap = h("div", "statement small", "<span>one prompt for one policy</span>", { top: "640px" }); e.appendChild(cap);
        gsap.set([z, cap], { opacity: 0, scale: 0.6 }); gsap.set(cards, { opacity: 0, y: 30 });
        // the cards show, then fly into one z, which holds with its caption until the next shot
        tl.to(cards, { opacity: 1, y: 0, duration: 0.3, stagger: 0.08 }, t0)
          .to(cards, { left: "880px", scale: 0.4, opacity: 0, duration: 0.5, ease: "power2.in" }, t0 + 0.75)
          .to(z, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.8)" }, t0 + 1.15).to(cap, { opacity: 1, scale: 1, duration: 0.3 }, t0 + 1.3);
        break;
      }
      case "bars": {
        e = h("div", "bars", (it.head ? `<div class="hd">${it.head}</div>` : ""), { left: px(it.x), top: px(it.y), width: px(it.w) });
        const rows = it.rows.map(r => {
          const row = h("div", "row", `${it.lw ? `<div class="lab" style="width:${it.lw}px">${r.lab}</div>` : ""}<div class="track"><div class="bar" style="background:${r.color}"></div><div class="val">${r.text}</div></div>`);
          e.appendChild(row); return row;
        });
        rows.forEach((row, i) => {
          const r = it.rows[i], bar = row.querySelector(".bar"), val = row.querySelector(".val");
          gsap.set(val, { opacity: 0, left: "0%" });
          tl.to(bar, { width: r.val + "%", duration: 0.8, ease: "power2.out" }, it.grow + i * 0.08)
            .to(val, { left: r.val + "%", duration: 0.8, ease: "power2.out" }, it.grow + i * 0.08).to(val, { opacity: 1, duration: 0.3 }, it.grow + i * 0.08 + 0.5);
        });
        // the bar of the prompt on screen stays bright; forward, the reference, always does
        (it.focus || []).forEach(([a, b, k]) => rows.forEach((row, i) => { if (i !== k && i !== 0) { tl.to(row, { opacity: 0.32, duration: 0.25 }, a); tl.to(row, { opacity: 1, duration: 0.25 }, b - 0.25); } }));
        break;
      }
      case "card": {
        const S = window.SPEC;
        e = it.kind === "title"
          ? h("div", "card", `<div class="t1">See<b>BFM</b></div><div class="t2">Behavior Foundation Model That Sees</div><div class="au">${S.author}</div><div class="af">${S.affil}</div>`)
          : h("div", "card", `<div class="t1" style="font-size:110px">See<b>BFM</b></div><div class="t2">Behavior Foundation Model That Sees</div><div class="au">${S.author}</div><div class="af">${S.affil}</div><div class="logoband">${(S.logoRows || [S.logos.length]).map((n, r, a) => S.logos.slice(a.slice(0, r).reduce((x, y) => x + y, 0)).slice(0, n)).map(row => `<div class="logorow">${row.map(([f, hh]) => `<img src="${S.logoDir || "logos/"}${f}" style="height:${hh}px" alt="">`).join("")}</div>`).join("")}</div><div class="url">${S.url}</div><div class="note">Every SeeBFM clip: the same policy, in simulation.</div>`);
        break;
      }
      default: return;
    }
    root.appendChild(e);
    span(tl, e, t0, t1, D);
  }

  function segment(seg, root, mode) {
    const tl = gsap.timeline(), vids = [];
    shots(seg, root, tl, mode, vids);
    seg.items.forEach(it => item(it, seg, root, tl));
    tl.to({}, { duration: 0.001 }, seg.dur);
    return { tl, vids };
  }

  // the narration in pieces, for the preview's burned-in subtitles and the slideshow's captions
  function pieces(seg) {
    if (!seg.voice) return [];
    const parts = seg.voice.split(/(?<=[.,;])\s+/).map(s => s.trim()).reduce((a, s) => {
      if (a.length && (a[a.length - 1] + " " + s).length <= 78) a[a.length - 1] += " " + s; else a.push(s); return a; }, []);
    const V = window.VOICE, total = parts.reduce((n, p) => n + p.length, 0);
    // timed to the generated voice when voice.js is loaded, else spread over the segment
    const t0 = V && V.leads[seg.n] != null ? V.leads[seg.n] : 0.4, t1 = V && V.lengths[seg.n] ? t0 + V.lengths[seg.n] : seg.dur - 0.3;
    let t = t0; return parts.map(p => { const d = (t1 - t0) * p.length / total, r = [t, t + d, p]; t += d; return r; });
  }
  return { segment, pieces, h };
})();
