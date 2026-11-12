/* Kalimat review mode: the interface.
   Loaded only when REVIEW_MODE_ENABLED is true in site.js.
   Saves and loads only through window.KalimatReviewStore (review-store.js). */
(function () {
  'use strict';

  var store = window.KalimatReviewStore;
  if (!store) { return; }

  var doc = document;
  var root = doc.documentElement;
  var SVG = 'http://www.w3.org/2000/svg';
  var MAX_FILE = 20 * 1024 * 1024;      // biggest picture file we accept
  var MAX_SIDE = 2000;                  // pictures are scaled down to this many pixels on the long side
  var KEEP_AS_IS = 1.5 * 1024 * 1024;   // small pictures are stored untouched

  // What a tap can land on, innermost match wins.
  var PICK = '.slot, img, h1, h2, h3, p, li, summary, legend, label, figcaption, blockquote > footer, a, button, input, select, textarea, .field, .sticker, .ticker, .stat, .poster, .tile, .case, .step, details, form, main > section, header.top, footer.footer';
  var EDITABLE = 'h1, h2, h3, p, li, summary, figcaption, label, legend, a, blockquote > footer';
  var BLOCKY = 'p, h1, h2, h3, ul, ol, div, details, img, form, input, select, textarea, figure, section, article, blockquote';

  var state = { reviewer: '', comments: [], edits: [], slots: {}, images: {} };
  var urls = {};        // picture key -> object URL
  var editInfo = {};    // element id -> { mode, node, original } for wording that is applied on the page
  var origSrc = {};     // picture key -> the src the page shipped with
  var openedDetails = [];
  var on = false;
  var persistent = true;
  var picked = null;
  var hinted = false;
  var ui = {};

  /* ================= small helpers ================= */
  function $all(sel, base) { return Array.prototype.slice.call((base || doc).querySelectorAll(sel)); }
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) { return; }
      if (k === 'text') { el.textContent = v; }
      else if (k === 'class') { el.className = v; }
      else if (k.slice(0, 2) === 'on') { el.addEventListener(k.slice(2), v); }
      else { el.setAttribute(k, v === true ? '' : v); }
    });
    (kids || []).forEach(function (kid) {
      if (kid) { el.appendChild(typeof kid === 'string' ? doc.createTextNode(kid) : kid); }
    });
    return el;
  }
  function icon(id) {
    var s = doc.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'icon');
    s.setAttribute('aria-hidden', 'true');
    var u = doc.createElementNS(SVG, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }
  function button(label, cls, fn) { return h('button', { type: 'button', class: 'rv-btn ' + (cls || ''), text: label, onclick: fn }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function norm(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function clip(text, n) { var t = norm(text); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function when(ts) {
    try { return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (err) { return new Date(ts).toISOString(); }
  }
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function userError(message) { var e = new Error(message); e.user = true; return e; }
  function needNumber(code) { return parseInt(String(code || '').replace(/\D/g, ''), 10) || 99; }

  /* ================= naming the parts of the page ================= */
  // An element is remembered as "section / tag : position", counted without
  // anything this file adds, so the address stays the same on every load.
  function rootOf(el) { return el.closest('main > section, header.top, footer.footer, #dock') || doc.body; }
  function rootKey(r) {
    if (r.id) { return r.id; }
    if (r.matches('header')) { return 'header'; }
    if (r.matches('footer')) { return 'footer'; }
    return 'body';
  }
  function rootByKey(key) {
    if (key === 'header') { return doc.querySelector('header.top'); }
    if (key === 'footer') { return doc.querySelector('footer.footer'); }
    if (key === 'body') { return doc.body; }
    return doc.getElementById(key);
  }
  function eligible(base, tag) {
    return Array.prototype.filter.call(base.getElementsByTagName(tag), function (n) {
      return !n.closest('.slot') && !n.closest('[data-rv]');
    });
  }
  function ridOf(el) {
    var slot = el.closest('.slot');
    if (slot) { return 'slot:' + slot.getAttribute('data-slot'); }
    var r = rootOf(el);
    if (el === r) { return rootKey(r); }
    var tag = el.tagName.toLowerCase();
    return rootKey(r) + '/' + tag + ':' + eligible(r, tag).indexOf(el);
  }
  function resolve(rid) {
    if (!rid) { return null; }
    if (rid.indexOf('slot:') === 0) { return doc.querySelector('.slot[data-slot="' + rid.slice(5).replace(/"/g, '') + '"]'); }
    var parts = rid.split('/');
    var base = rootByKey(parts[0]);
    if (!base || parts.length === 1) { return base; }
    var bits = parts[1].split(':');
    return eligible(base, bits[0])[parseInt(bits[1], 10)] || null;
  }
  function labelOf(el) {
    var r = rootOf(el);
    return r.getAttribute('data-label') || (r.matches('header') ? 'Header' : r.id === 'dock' ? 'Floating button' : 'Page');
  }
  function describe(el) {
    if (el.matches('.slot')) { return 'Missing content'; }
    if (el.matches('img')) { return 'Picture'; }
    if (el.matches('h1, h2, h3')) { return 'Heading'; }
    if (el.matches('.btn, button')) { return 'Button'; }
    if (el.matches('a')) { return 'Link'; }
    if (el.matches('summary')) { return 'Question'; }
    if (el.matches('p, li, label, legend, figcaption, blockquote > footer')) { return 'Text'; }
    if (el.matches('main > section, header.top, footer.footer')) { return 'Whole section'; }
    return 'Block';
  }
  function snippet(el) {
    if (el.matches('.slot')) { return el.getAttribute('data-title') || 'Missing content'; }
    if (el.matches('img')) { return el.getAttribute('alt') || 'Picture'; }
    return clip(el.textContent, 90) || describe(el);
  }

  /* ================= wording ================= */
  function directText(el) {
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
  }
  // How new wording can be shown for this element:
  //   whole   the element holds only text, so the text is swapped
  //   node    one run of text beside an icon or a small label, so only that run is swapped
  //   record  styled words inside (highlight, strike, counter), so the page is left alone
  //           and the suggestion is kept in the feedback
  function textTarget(el) {
    if (!el.matches(EDITABLE) || el.closest('.btn, button, .slot')) { return null; }
    if (el.querySelector(BLOCKY) || !norm(el.textContent)) { return null; }
    if (el.hasAttribute('data-count') || el.querySelector('[data-count]')) { return { mode: 'record', node: el }; }
    var node = el;
    while (node.children.length === 1 && !directText(node).length) { node = node.children[0]; }
    if (!node.children.length) { return { mode: 'whole', node: node }; }
    var texts = directText(node);
    var onlyIcons = Array.prototype.every.call(node.children, function (c) { return c.tagName.toLowerCase() === 'svg'; });
    if (texts.length === 1 && (onlyIcons || norm(texts[0].nodeValue).length >= norm(node.textContent).length * 0.5)) {
      return { mode: 'node', node: texts[0] };
    }
    return { mode: 'record', node: el };
  }
  function readText(info) {
    if (info.mode === 'whole') { return norm(info.node.textContent); }
    if (info.mode === 'node') { return norm(info.node.nodeValue); }
    return norm(info.node.textContent);
  }
  function findEdit(rid) {
    for (var i = 0; i < state.edits.length; i++) { if (state.edits[i].rid === rid) { return state.edits[i]; } }
    return null;
  }
  function applyEdit(edit) {
    var el = resolve(edit.rid);
    if (!el) { return; }
    var info = editInfo[edit.rid] || textTarget(el);
    if (!info) { return; }
    el.setAttribute('data-rv-edited', '');
    if (info.mode === 'record') { return; }
    if (!editInfo[edit.rid]) {
      info.original = info.mode === 'whole' ? info.node.textContent : info.node.nodeValue;
      editInfo[edit.rid] = info;
    }
    if (info.mode === 'whole') { info.node.textContent = edit.suggested; } else { info.node.nodeValue = edit.suggested; }
    // Arabic typed into an English line (or the reverse) should read in its own direction.
    if (!el.hasAttribute('dir')) { el.setAttribute('dir', 'auto'); info.addedDir = true; }
  }
  function restoreEdit(rid) {
    var el = resolve(rid);
    var info = editInfo[rid];
    if (el) { el.removeAttribute('data-rv-edited'); }
    if (!info) { return; }
    if (info.mode === 'whole') { info.node.textContent = info.original; } else { info.node.nodeValue = info.original; }
    if (info.addedDir && el) { el.removeAttribute('dir'); }
    delete editInfo[rid];
  }

  /* ================= pictures ================= */
  function megabytes(bytes) { return (bytes / 1048576).toFixed(1); }
  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve2) { canvas.toBlob(resolve2, type, quality); });
  }
  // Checks the file, then scales big pictures down so storage does not fill up.
  function prepareImage(file) {
    return new Promise(function (resolve2, reject) {
      if (!file || !/^image\//.test(file.type || '')) {
        reject(userError('That file is not a picture. Choose a JPG, PNG or WebP image.'));
        return;
      }
      if (file.size > MAX_FILE) {
        reject(userError('That picture is ' + megabytes(file.size) + ' MB. The limit is 20 MB. Choose a smaller one.'));
        return;
      }
      if (file.type === 'image/svg+xml') {
        if (file.size > 1048576) { reject(userError('That SVG file is over 1 MB. Export a simpler one.')); return; }
        resolve2({ blob: file, width: 0, height: 0, scaled: false });
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(userError('This browser cannot open that picture. iPhone HEIC photos often do this. Save it as JPG or PNG and try again.'));
      };
      img.onload = function () {
        var w = img.naturalWidth;
        var ht = img.naturalHeight;
        if (!w || !ht) { img.onerror(); return; }
        var scale = Math.min(1, MAX_SIDE / Math.max(w, ht));
        if (scale === 1 && file.size <= KEEP_AS_IS) {
          URL.revokeObjectURL(url);
          resolve2({ blob: file, width: w, height: ht, scaled: false });
          return;
        }
        var canvas = doc.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(ht * scale);
        var ctx = canvas.getContext('2d');
        var asJpeg = file.type === 'image/jpeg';
        if (asJpeg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvasBlob(canvas, asJpeg ? 'image/jpeg' : 'image/png', 0.86).then(function (blob) {
          if (blob && !asJpeg && blob.size > 4 * 1048576) {
            // A very heavy PNG: flatten it onto white and keep it as JPG.
            var flat = doc.createElement('canvas');
            flat.width = canvas.width;
            flat.height = canvas.height;
            var fctx = flat.getContext('2d');
            fctx.fillStyle = '#fff';
            fctx.fillRect(0, 0, flat.width, flat.height);
            fctx.drawImage(canvas, 0, 0);
            return canvasBlob(flat, 'image/jpeg', 0.86);
          }
          return blob;
        }).then(function (blob) {
          if (!blob) { reject(userError('That picture could not be prepared. Try a JPG or PNG.')); return; }
          resolve2({ blob: blob, width: canvas.width, height: canvas.height, scaled: scale < 1 });
        });
      };
      img.src = url;
    });
  }
  function putImage(key, blob, meta) {
    return store.putImage(key, blob, meta).then(function () {
      if (urls[key]) { URL.revokeObjectURL(urls[key]); }
      urls[key] = URL.createObjectURL(blob);
      state.images[key] = meta;
    });
  }
  function dropImage(key) {
    return store.deleteImage(key).then(function () {
      if (urls[key]) { URL.revokeObjectURL(urls[key]); }
      delete urls[key];
      delete state.images[key];
    });
  }
  function applyImage(key) {
    var img = resolve(key.slice(4));
    if (!img || !urls[key]) { return; }
    if (!(key in origSrc)) { origSrc[key] = { src: img.getAttribute('src'), srcset: img.getAttribute('srcset') }; }
    img.removeAttribute('srcset');
    img.setAttribute('loading', 'eager');     // the picture is already on this device, no reason to wait
    img.setAttribute('src', urls[key]);
    img.setAttribute('data-rv-replaced', '');
  }
  function restoreImage(key) {
    var img = resolve(key.slice(4));
    var orig = origSrc[key];
    if (!img || !orig) { return; }
    img.setAttribute('src', orig.src);
    if (orig.srcset) { img.setAttribute('srcset', orig.srcset); }
    img.removeAttribute('data-rv-replaced');
    delete origSrc[key];
  }
  function fileMeta(file, prepared, extra) {
    var meta = { name: file.name || 'picture', type: prepared.blob.type, size: prepared.blob.size, width: prepared.width, height: prepared.height, by: state.reviewer, at: Date.now() };
    Object.keys(extra || {}).forEach(function (k) { meta[k] = extra[k]; });
    return meta;
  }
  // Opens the phone or computer file chooser. The input lives inside the sheet.
  function chooseFiles(multiple) {
    return new Promise(function (resolve2) {
      $all('input[type="file"]', ui.sheet).forEach(function (old) { old.remove(); });
      var input = h('input', { type: 'file', accept: 'image/*', class: 'rv-sr', multiple: multiple, tabindex: '-1', 'aria-hidden': 'true' });
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        input.remove();
        resolve2(files);
      });
      input.addEventListener('cancel', function () { input.remove(); resolve2([]); });
      ui.sheet.appendChild(input);
      input.click();
    });
  }

  /* ================= missing content (the slots) ================= */
  function slotKey(slot) { return slot.getAttribute('data-slot'); }
  function slotKind(slot) { return slot.getAttribute('data-kind'); }
  function slotValue(key) { return (state.slots[key] && state.slots[key].value) || {}; }
  function slotImageKeys(key) {
    return Object.keys(state.images).filter(function (k) { return k === 'slot:' + key || k.indexOf('slot:' + key + ':') === 0; });
  }
  function slotFilled(slot) {
    var key = slotKey(slot);
    var v = slotValue(key);
    switch (slotKind(slot)) {
      case 'logos': return !!(v.items && v.items.length);
      case 'quote': return !!v.quote;
      case 'result': return !!v.number;
      case 'image': return !!state.images['slot:' + key];
      default: return !!v.text;
    }
  }
  function slotSummary(slot) {
    var v = slotValue(slotKey(slot));
    switch (slotKind(slot)) {
      case 'logos': return (v.items || []).length + ((v.items || []).length === 1 ? ' logo' : ' logos');
      case 'quote': return '“' + clip(v.quote, 70) + '” ' + [v.name, v.role].filter(Boolean).join(', ');
      case 'result': return [v.number, v.label].filter(Boolean).join(' ');
      case 'image': return 'Picture added';
      default: return v.text || '';
    }
  }
  // What the public sees once a slot is filled. Built with text nodes only.
  function slotContent(slot) {
    var key = slotKey(slot);
    var v = slotValue(key);
    switch (slotKind(slot)) {
      case 'logos':
        return h('div', { class: 'logos' }, [
          h('p', { class: 'logos__label', text: 'Trusted by' }),
          h('div', { class: 'logos__row' }, (v.items || []).map(function (item) {
            var src = urls['slot:' + key + ':' + item.id];
            return src ? h('span', { class: 'logos__item' }, [h('img', { src: src, alt: item.name || 'Client logo' })]) : null;
          }))
        ]);
      case 'quote':
        var photo = urls['slot:' + key + ':photo'];
        return h('figure', { class: 'quote' }, [
          h('blockquote', { class: 'quote__text', dir: 'auto', text: '“' + v.quote + '”' }),
          h('figcaption', { class: 'quote__who' }, [
            photo ? h('img', { src: photo, alt: '' }) : null,
            h('div', null, [h('b', { dir: 'auto', text: v.name || '' }), h('span', { dir: 'auto', text: v.role || '' })])
          ])
        ]);
      case 'result':
        return h('p', { class: 'result' }, [h('b', { dir: 'auto', text: v.number }), h('span', { dir: 'auto', text: v.label || '' })]);
      case 'image':
        return h('div', { class: 'cover' }, [h('img', { src: urls['slot:' + key], alt: '' })]);
      case 'tick':
        return h('ul', { class: 'ticks ticks--more' }, [h('li', { dir: 'auto' }, [icon('i-check'), v.text])]);
      case 'faq':
        return h('details', null, [
          h('summary', null, [slot.getAttribute('data-title'), icon('i-plus')]),
          h('p', { dir: 'auto', text: v.text })
        ]);
      default:
        return null;   // notes are for Adib only, never shown on the page
    }
  }
  function renderSlot(slot) {
    var filled = slotFilled(slot);
    slot.textContent = '';
    slot.removeAttribute('hidden');
    slot.classList.toggle('is-filled', filled);
    if (filled) {
      var content = slotContent(slot);
      if (content) { slot.appendChild(content); }
    }
    if (on) {
      slot.appendChild(h('div', { class: 'rv-slot' + (filled ? ' is-done' : '') }, [
        h('span', { class: 'rv-slot__need', text: slot.getAttribute('data-need') }),
        h('span', { class: 'rv-slot__text' }, [
          h('b', { text: slot.getAttribute('data-title') }),
          h('span', { dir: 'auto', text: filled ? (slotKind(slot) === 'note' ? slotSummary(slot) : 'Added. Tap to change.') : slot.getAttribute('data-ask') })
        ]),
        h('span', { class: 'rv-slot__go', text: filled ? 'Change' : 'Add' })
      ]));
    }
  }
  function renderSlots() { $all('.slot[data-slot]').forEach(renderSlot); }

  // The checklist: every slot, plus pictures marked as stand-ins.
  function needItems() {
    var items = $all('.slot[data-need]').map(function (slot) {
      return { need: slot.getAttribute('data-need'), title: slot.getAttribute('data-title'), ask: slot.getAttribute('data-ask'), el: slot, done: slotFilled(slot), value: slotFilled(slot) ? slotSummary(slot) : '' };
    });
    $all('img[data-need]').forEach(function (img) {
      if (img.closest('.slot, [data-rv]')) { return; }
      var done = !!state.images['img:' + ridOf(img)];
      items.push({ need: img.getAttribute('data-need'), title: img.getAttribute('data-title') || 'Picture', ask: img.getAttribute('data-ask') || '', el: img, done: done, value: done ? 'Picture added' : '' });
    });
    return items.sort(function (a, b) { return needNumber(a.need) - needNumber(b.need); });
  }

  /* ================= messages ================= */
  var toastTimer = null;
  function toast(message, isError) {
    ui.toast.textContent = message;
    ui.toast.className = 'rv-toast' + (isError ? ' is-error' : '');
    ui.toast.setAttribute('role', isError ? 'alert' : 'status');
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.hidden = true; }, isError ? 9000 : 4200);
  }
  function problem(err) {
    if (err && err.user) { toast(err.message, true); return; }
    if (err && err.code === 'full') {
      toast('This browser has no storage room left, so that was not saved. Tap Send feedback now, then remove a few pictures and try again.', true);
      return;
    }
    if (err && err.code === 'blocked') {
      toast('This browser refused to save. Private browsing can cause this. Tap Send feedback before you close this tab.', true);
      return;
    }
    toast('Something went wrong and that was not saved. Please try again.', true);
    if (window.console) { console.error(err); }
  }

  /* ================= the sheet (opens when something is tapped) ================= */
  function shell(kicker, title, body) {
    ui.sheetBody.textContent = '';
    ui.sheetBody.appendChild(h('div', { class: 'rv-sheet__head' }, [
      h('div', null, [h('p', { class: 'rv-kicker', text: kicker }), h('p', { class: 'rv-sheet__title', dir: 'auto', text: title })]),
      h('button', { type: 'button', class: 'rv-x', 'aria-label': 'Close', text: '×', onclick: closeSheet })
    ]));
    body.forEach(function (node) { if (node) { ui.sheetBody.appendChild(node); } });
    ui.sheet.hidden = false;
  }
  function closeSheet() {
    ui.sheet.hidden = true;
    ui.sheetBody.textContent = '';
    picked = null;
    ui.hl.hidden = true;
  }
  function ensureName() {
    if (state.reviewer) { return Promise.resolve(); }
    return new Promise(function (resolve2) {
      var input = h('input', { type: 'text', class: 'rv-input', dir: 'auto', autocomplete: 'name', placeholder: 'Your name', 'aria-label': 'Your name' });
      var error = h('p', { class: 'rv-error', hidden: true, text: 'Please add your name.' });
      var form = h('form', { class: 'rv-form', onsubmit: function (e) {
        e.preventDefault();
        var name = input.value.trim();
        if (!name) { error.hidden = false; input.focus(); return; }
        state.reviewer = name;
        store.setReviewer(name).then(resolve2, function (err) { problem(err); resolve2(); });
      } }, [input, error, h('button', { type: 'submit', class: 'rv-btn rv-btn--main', text: 'Continue' })]);
      shell('One question first', 'Who is reviewing?', [
        h('p', { class: 'rv-help', text: 'Your name goes next to every note you leave. We ask once.' }),
        form
      ]);
      input.focus();
    });
  }

  function openSheet(el) {
    closePanel();
    picked = el;
    showHighlight(el);
    if (el.matches('.slot')) { viewSlot(el); } else { viewMain(el); }
  }

  // Default view: a comment box, plus whatever else this element allows.
  function viewMain(el) {
    var rid = ridOf(el);
    var isImg = el.matches('img');
    var canWord = !!textTarget(el);
    var existing = state.comments.filter(function (c) { return c.rid === rid; });
    var box = h('textarea', { class: 'rv-input', rows: '3', dir: 'auto', placeholder: 'What should change here?', 'aria-label': 'Your comment' });
    var error = h('p', { class: 'rv-error', hidden: true, text: 'Write a few words first.' });
    var form = h('form', { class: 'rv-form', onsubmit: function (e) {
      e.preventDefault();
      var text = box.value.trim();
      if (!text) { error.hidden = false; box.focus(); return; }
      addComment(el, text);
    } }, [box, error, h('button', { type: 'submit', class: 'rv-btn rv-btn--main', text: 'Save comment' })]);

    var more = h('div', { class: 'rv-row' }, [
      canWord ? button(findEdit(rid) ? 'Edit your wording' : 'Suggest new wording', '', function () { viewWording(el); }) : null,
      isImg ? button(state.images['img:' + rid] ? 'Choose another picture' : 'Replace this picture', '', function () { replaceImage(el); }) : null,
      isImg && state.images['img:' + rid] ? button('Put the original back', 'rv-btn--quiet', function () { removeImage('img:' + rid); }) : null,
      el.matches('.slot') ? button('Back', 'rv-btn--quiet', function () { viewSlot(el); }) : null
    ]);

    shell(describe(el) + ' · ' + labelOf(el), el.matches('.slot') ? snippet(el) : '“' + snippet(el) + '”', [
      isImg && el.getAttribute('data-ask') && !state.images['img:' + rid] ? h('p', { class: 'rv-help', text: el.getAttribute('data-ask') }) : null,
      existing.length ? h('ul', { class: 'rv-mini' }, existing.map(function (c) {
        return h('li', { dir: 'auto' }, [h('b', { text: '#' + c.n + ' ' + c.by + ': ' }), c.text]);
      })) : null,
      form,
      more.children.length ? more : null
    ]);
    if (window.matchMedia('(min-width: 761px)').matches) { box.focus(); }
  }

  function viewWording(el) {
    var rid = ridOf(el);
    var info = editInfo[rid] || textTarget(el);
    var edit = findEdit(rid);
    var original = edit ? edit.original : readText(info);
    var box = h('textarea', { class: 'rv-input', rows: '3', dir: 'auto', 'aria-label': 'New wording' });
    box.value = edit ? edit.suggested : original;
    var error = h('p', { class: 'rv-error', hidden: true, text: 'Write the new wording first.' });
    var form = h('form', { class: 'rv-form', onsubmit: function (e) {
      e.preventDefault();
      var text = norm(box.value);
      if (!text) { error.hidden = false; box.focus(); return; }
      if (text === original) { if (edit) { removeEdit(rid); } else { closeSheet(); } return; }
      saveWording(el, info, original, text);
    } }, [box, error, h('button', { type: 'submit', class: 'rv-btn rv-btn--main', text: 'Save wording' })]);

    shell('New wording · ' + labelOf(el), 'Suggest how this should read', [
      h('p', { class: 'rv-label', text: 'On the page now' }),
      h('p', { class: 'rv-old', dir: 'auto', text: original }),
      h('p', { class: 'rv-label', text: 'Your wording' }),
      form,
      info.mode === 'record' ? h('p', { class: 'rv-help', text: 'This line has styled words inside it, so the page keeps the current words. Your wording is saved in the feedback.' }) : null,
      h('div', { class: 'rv-row' }, [
        edit ? button('Put the original back', 'rv-btn--quiet', function () { removeEdit(rid); }) : null,
        button('Back', 'rv-btn--quiet', function () { viewMain(el); })
      ])
    ]);
    box.focus();
  }

  // Fields for each kind of missing content.
  function viewSlot(slot) {
    var key = slotKey(slot);
    var kind = slotKind(slot);
    var v = slotValue(key);
    var filled = slotFilled(slot);
    var fields = [];
    var inputs = {};
    function field(name, label, tag, extra) {
      var attrs = { class: 'rv-input', dir: 'auto', 'aria-label': label, placeholder: label };
      if (tag === 'textarea') { attrs.rows = '3'; } else { attrs.type = 'text'; }
      Object.keys(extra || {}).forEach(function (k) { attrs[k] = extra[k]; });
      var input = h(tag, attrs);
      input.value = v[name] || '';
      inputs[name] = input;
      fields.push(input);
    }
    var need = { quote: 'quote', result: 'number', tick: 'text', faq: 'text', note: 'text' }[kind];
    if (kind === 'quote') {
      field('quote', 'What the client said', 'textarea');
      field('name', 'Their name', 'input');
      field('role', 'Their title and company', 'input');
    } else if (kind === 'result') {
      field('number', 'The number, for example 120 or 35%', 'input');
      field('label', 'What it counts, for example reports delivered', 'input');
    } else if (need) {
      field('text', slot.getAttribute('data-field') || 'Your answer', kind === 'tick' ? 'input' : 'textarea');
    }

    var error = h('p', { class: 'rv-error', hidden: true, text: 'Fill in the first box.' });
    var pictures = h('div', { class: 'rv-thumbs' });
    slotImageKeys(key).forEach(function (imageKey) {
      pictures.appendChild(h('span', { class: 'rv-thumb' }, [
        h('img', { src: urls[imageKey], alt: (state.images[imageKey] || {}).name || '' }),
        h('button', { type: 'button', class: 'rv-thumb__x', 'aria-label': 'Remove this picture', text: '×', onclick: function () { removeSlotImage(slot, imageKey); } })
      ]));
    });

    var pictureLabel = { logos: 'Add logos', image: filled ? 'Choose another picture' : 'Choose a picture', quote: state.images['slot:' + key + ':photo'] ? 'Change their photo' : 'Add their photo (optional)' }[kind];
    var form = h('form', { class: 'rv-form', onsubmit: function (e) {
      e.preventDefault();
      if (!need) { return; }
      var value = {};
      Object.keys(inputs).forEach(function (name) { value[name] = inputs[name].value.trim(); });
      if (!value[need]) { error.hidden = false; inputs[need].focus(); return; }
      saveSlot(slot, value, true);
    } }, fields.concat([
      need ? error : null,
      pictures.children.length ? pictures : null,
      need ? h('button', { type: 'submit', class: 'rv-btn rv-btn--main', text: filled ? 'Save changes' : 'Save' }) : null,
      pictureLabel ? button(pictureLabel, need ? '' : 'rv-btn--main', function () {
        // A quote needs its words saved before a photo makes sense.
        if (kind === 'quote' && !inputs.quote.value.trim()) { error.hidden = false; inputs.quote.focus(); return; }
        addSlotPictures(slot, inputs);
      }) : null
    ]));

    shell(slot.getAttribute('data-need') + ' · ' + labelOf(slot), slot.getAttribute('data-title'), [
      h('p', { class: 'rv-help', text: slot.getAttribute('data-ask') }),
      kind === 'note' ? h('p', { class: 'rv-help', text: 'This answer goes to Adib. It is not shown on the website.' }) : null,
      form,
      h('div', { class: 'rv-row' }, [
        filled ? button('Clear this', 'rv-btn--quiet', function () { clearSlot(slot); }) : null,
        button('Leave a comment instead', 'rv-btn--quiet', function () { viewMain(slot); })
      ])
    ]);
    if (fields[0] && window.matchMedia('(min-width: 761px)').matches) { fields[0].focus(); }
  }

  /* ================= saving ================= */
  function refresh() {
    renderPins();
    updateCount();
    if (!ui.panel.hidden) { renderPanel(); }
  }
  function addComment(el, text) {
    var rid = ridOf(el);
    var label = labelOf(el);
    var what = describe(el);
    var snip = snippet(el);
    return ensureName().then(function () {
      var n = state.comments.reduce(function (m, c) { return Math.max(m, c.n || 0); }, 0) + 1;
      var comment = { id: uid(), n: n, rid: rid, label: label, what: what, snippet: snip, text: text, by: state.reviewer, at: Date.now(), resolved: false };
      return store.saveComment(comment).then(function () {
        state.comments.push(comment);
        closeSheet();
        refresh();
        toast('Comment ' + n + ' saved.');
      });
    }).catch(problem);
  }
  function saveWording(el, info, original, text) {
    var rid = ridOf(el);
    var label = labelOf(el);
    var what = describe(el);
    return ensureName().then(function () {
      var edit = { id: 'e:' + rid, rid: rid, label: label, what: what, original: original, suggested: text, applied: info.mode !== 'record', by: state.reviewer, at: Date.now() };
      return store.saveEdit(edit).then(function () {
        state.edits = state.edits.filter(function (x) { return x.id !== edit.id; }).concat(edit);
        applyEdit(edit);
        closeSheet();
        refresh();
        toast(edit.applied ? 'New wording saved and shown on the page.' : 'New wording saved in your feedback.');
      });
    }).catch(problem);
  }
  function removeEdit(rid) {
    return store.deleteEdit('e:' + rid).then(function () {
      state.edits = state.edits.filter(function (x) { return x.rid !== rid; });
      restoreEdit(rid);
      closeSheet();
      refresh();
      toast('Original wording is back.');
    }).catch(problem);
  }
  function replaceImage(img) {
    var rid = ridOf(img);
    var key = 'img:' + rid;
    var extra = { label: labelOf(img), alt: img.getAttribute('alt') || '', need: img.getAttribute('data-need') || '' };
    return chooseFiles(false).then(function (files) {
      if (!files.length) { return null; }
      return prepareImage(files[0]).then(function (prepared) {
        return ensureName().then(function () { return putImage(key, prepared.blob, fileMeta(files[0], prepared, extra)); }).then(function () {
          applyImage(key);
          closeSheet();
          refresh();
          toast(prepared.scaled ? 'Picture replaced. It was large, so it was scaled down.' : 'Picture replaced. It also shows with review mode off.');
        });
      });
    }).catch(problem);
  }
  function removeImage(key) {
    return dropImage(key).then(function () {
      restoreImage(key);
      closeSheet();
      refresh();
      toast('Original picture is back.');
    }).catch(problem);
  }
  function slotEntry(slot, value) {
    return { kind: slotKind(slot), need: slot.getAttribute('data-need'), title: slot.getAttribute('data-title'), label: labelOf(slot), value: value, by: state.reviewer, at: Date.now() };
  }
  function saveSlot(slot, value, close) {
    var key = slotKey(slot);
    var current = slotValue(key);
    if (current.items && !value.items) { value.items = current.items; }
    return ensureName().then(function () {
      var entry = slotEntry(slot, value);
      return store.saveSlot(key, entry).then(function () {
        state.slots[key] = entry;
        renderSlot(slot);
        refresh();
        if (close) {
          closeSheet();
          toast(slotKind(slot) === 'note' ? 'Saved. Adib will see it in your feedback.' : 'Saved. It now shows on the page.');
        }
      });
    }).catch(problem);
  }
  function addSlotPictures(slot, inputs) {
    var key = slotKey(slot);
    var kind = slotKind(slot);
    var extra = { label: labelOf(slot), need: slot.getAttribute('data-need') || '', slot: key };
    return chooseFiles(kind === 'logos').then(function (files) {
      if (!files.length) { return null; }
      return ensureName().then(function () {
        var value = JSON.parse(JSON.stringify(slotValue(key)));
        Object.keys(inputs || {}).forEach(function (name) { value[name] = inputs[name].value.trim(); });
        var skipped = [];
        var chain = files.reduce(function (p, file) {
          return p.then(function () {
            return prepareImage(file).then(function (prepared) {
              var imageKey = 'slot:' + key;
              if (kind === 'logos') {
                var id = uid();
                imageKey += ':' + id;
                value.items = (value.items || []).concat({ id: id, name: (file.name || 'logo').replace(/\.[a-z0-9]+$/i, '') });
              } else if (kind === 'quote') {
                imageKey += ':photo';
              }
              return putImage(imageKey, prepared.blob, fileMeta(file, prepared, extra));
            }, function (err) {
              if (err && err.user) { skipped.push((file.name || 'One file') + ': ' + err.message); return null; }
              throw err;
            });
          });
        }, Promise.resolve());
        return chain.then(function () {
          var entry = slotEntry(slot, value);
          return store.saveSlot(key, entry).then(function () {
            state.slots[key] = entry;
            renderSlot(slot);
            refresh();
            if (skipped.length) { toast(skipped.join(' '), true); } else { toast('Picture added. It now shows on the page.'); }
            if (skipped.length === files.length) { return; }
            if (kind === 'image') { closeSheet(); } else { viewSlot(slot); }
          });
        });
      });
    }).catch(problem);
  }
  function removeSlotImage(slot, imageKey) {
    var key = slotKey(slot);
    return dropImage(imageKey).then(function () {
      var value = JSON.parse(JSON.stringify(slotValue(key)));
      if (value.items) {
        var id = imageKey.split(':').pop();
        value.items = value.items.filter(function (item) { return item.id !== id; });
      }
      var entry = slotEntry(slot, value);
      return store.saveSlot(key, entry).then(function () {
        state.slots[key] = entry;
        renderSlot(slot);
        refresh();
        viewSlot(slot);
      });
    }).catch(problem);
  }
  function clearSlot(slot) {
    var key = slotKey(slot);
    return slotImageKeys(key).reduce(function (p, imageKey) {
      return p.then(function () { return dropImage(imageKey); });
    }, Promise.resolve()).then(function () {
      return store.deleteSlot(key);
    }).then(function () {
      delete state.slots[key];
      renderSlot(slot);
      closeSheet();
      refresh();
      toast('Cleared.');
    }).catch(problem);
  }

  /* ================= pins and the highlight box ================= */
  function showHighlight(el) {
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) { ui.hl.hidden = true; return; }
    var left = Math.max(r.left + window.scrollX - 4, 2);
    ui.hl.style.left = left + 'px';
    ui.hl.style.top = (r.top + window.scrollY - 4) + 'px';
    ui.hl.style.width = Math.max(Math.min(r.width + 8, root.clientWidth - left - 2), 0) + 'px';
    ui.hl.style.height = (r.height + 8) + 'px';
    ui.hl.hidden = false;
  }
  function renderPins() {
    ui.pins.textContent = '';
    if (!on) { return; }
    state.comments.forEach(function (c) {
      ui.pins.appendChild(h('button', {
        type: 'button', class: 'rv-pin' + (c.resolved ? ' is-resolved' : ''), 'data-id': c.id,
        'aria-label': 'Comment ' + c.n + ' by ' + c.by, text: String(c.n),
        onclick: function () { openPanel(c.id); }
      }));
    });
    needItems().forEach(function (item) {
      if (item.el.matches('img') && !item.done) {
        var chip = h('span', { class: 'rv-chip', text: item.need + ' · ' + item.ask });
        chip._anchor = item.el;
        ui.pins.appendChild(chip);
      }
    });
    place();
  }
  function place() {
    if (!on) { return; }
    var docW = root.clientWidth;
    var stacked = {};
    Array.prototype.forEach.call(ui.pins.children, function (node) {
      var comment = null;
      if (node.matches('.rv-pin')) {
        var id = node.getAttribute('data-id');
        comment = state.comments.filter(function (c) { return c.id === id; })[0];
      }
      var anchor = comment ? resolve(comment.rid) : node._anchor;
      var r = anchor && anchor.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) { node.hidden = true; return; }
      node.hidden = false;
      var x, y;
      if (comment) {
        // Sit on the corner of the words themselves, not of the wide box around them.
        if (!anchor.matches('img, .slot') && anchor.childNodes.length) {
          var range = doc.createRange();
          range.selectNodeContents(anchor);
          var tight = range.getBoundingClientRect();
          if (tight.width && tight.height) { r = tight; }
        }
        var i = stacked[comment.rid] = (stacked[comment.rid] || 0) + 1;
        x = Math.min(Math.max(r.right + window.scrollX - 16 - (i - 1) * 32, 4), docW - 34);
        y = Math.max(r.top + window.scrollY - 14, 4);
      } else {
        x = Math.max(r.left + window.scrollX + 10, 4);
        y = r.top + window.scrollY + 10;
        node.style.maxWidth = Math.max(Math.min(r.width - 20, docW - x - 8), 120) + 'px';
      }
      node.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    });
    if (picked) { showHighlight(picked); }
  }
  var placeQueued = false;
  function queuePlace() {
    if (!on || placeQueued) { return; }
    placeQueued = true;
    requestAnimationFrame(function () { placeQueued = false; place(); });
  }

  /* ================= the panel (everything left so far) ================= */
  function countAll() {
    return state.comments.length + state.edits.length + Object.keys(state.images).filter(function (k) { return k.indexOf('img:') === 0; }).length +
      $all('.slot[data-slot]').filter(slotFilled).length;
  }
  function updateCount() {
    var n = countAll();
    ui.count.textContent = '';
    ui.count.appendChild(doc.createTextNode('Your feedback'));
    ui.count.appendChild(h('b', { text: String(n) }));
  }
  function jump(el) {
    closePanel();
    if (!el) { toast('That part of the page is no longer there.', true); return; }
    el.scrollIntoView({ block: 'center', behavior: root.classList.contains('rv-still') ? 'auto' : 'smooth' });
    setTimeout(function () { openSheet(el); }, 450);
  }
  function openPanel(focusId) {
    closeSheet();
    ui.panel.hidden = false;
    renderPanel();
    if (focusId) {
      var item = ui.panelBody.querySelector('[data-id="' + focusId + '"]');
      if (item) { item.classList.add('is-flash'); item.scrollIntoView({ block: 'center' }); }
    }
  }
  function closePanel() { ui.panel.hidden = true; }
  function section(title, count, items, empty) {
    return h('section', { class: 'rv-group' }, [
      h('h3', { class: 'rv-group__title' }, [title, h('span', { text: String(count) })]),
      items.length ? h('ul', { class: 'rv-list' }, items) : h('p', { class: 'rv-empty', text: empty })
    ]);
  }
  function renderPanel() {
    var body = ui.panelBody;
    var keepScroll = body.scrollTop;
    body.textContent = '';

    body.appendChild(h('div', { class: 'rv-panel__head' }, [
      h('div', null, [
        h('p', { class: 'rv-kicker', text: 'Review mode' }),
        h('p', { class: 'rv-sheet__title', text: 'Your feedback' })
      ]),
      h('button', { type: 'button', class: 'rv-x', 'aria-label': 'Close', text: '×', onclick: closePanel })
    ]));
    if (state.reviewer) {
      body.appendChild(h('p', { class: 'rv-who' }, [
        'Reviewing as ', h('b', { dir: 'auto', text: state.reviewer }), ' ',
        h('button', { type: 'button', class: 'rv-link', text: 'Change', onclick: function () {
          var name = window.prompt('Your name', state.reviewer);
          if (name && name.trim()) {
            state.reviewer = name.trim();
            store.setReviewer(state.reviewer).then(renderPanel, problem);
          }
        } })
      ]));
    }
    body.appendChild(h('p', { class: 'rv-warn' + (persistent ? '' : ' is-loud'), text: persistent
      ? 'Your notes are saved in this browser only. Nobody else sees them until you tap Send feedback and pass on the file.'
      : 'This browser is not saving anything (private browsing, or storage is switched off). Your notes disappear when this tab closes. Tap Send feedback before you leave.' }));

    /* comments */
    var comments = state.comments.slice().sort(function (a, b) { return a.n - b.n; }).map(function (c) {
      var text = h('p', { class: 'rv-item__text', dir: 'auto', text: c.text });
      var li = h('li', { class: 'rv-item' + (c.resolved ? ' is-resolved' : ''), 'data-id': c.id }, [
        h('p', { class: 'rv-item__meta' }, [h('b', { text: '#' + c.n }), ' ' + c.label + ' · ' + c.what + ' · ' + c.by]),
        h('p', { class: 'rv-item__on', dir: 'auto', text: c.what === 'Missing content' ? c.snippet : '“' + c.snippet + '”' }),
        text,
        h('div', { class: 'rv-row' }, [
          button('Show', 'rv-btn--tiny', function () { jump(resolve(c.rid)); }),
          button('Edit', 'rv-btn--tiny', function () {
            var box = h('textarea', { class: 'rv-input', rows: '3', dir: 'auto', 'aria-label': 'Edit comment ' + c.n });
            box.value = c.text;
            var save = button('Save', 'rv-btn--tiny rv-btn--main', function () {
              var next = box.value.trim();
              if (!next) { box.focus(); return; }
              var updated = Object.assign({}, c, { text: next, editedAt: Date.now() });
              store.saveComment(updated).then(function () { Object.assign(c, updated); refresh(); }, problem);
            });
            text.replaceWith(h('div', { class: 'rv-form' }, [box, save]));
            box.focus();
          }),
          button(c.resolved ? 'Reopen' : 'Resolved', 'rv-btn--tiny', function () {
            var updated = Object.assign({}, c, { resolved: !c.resolved });
            store.saveComment(updated).then(function () { Object.assign(c, updated); refresh(); }, problem);
          }),
          button('Delete', 'rv-btn--tiny rv-btn--danger', function () {
            if (!window.confirm('Delete comment ' + c.n + '?')) { return; }
            store.deleteComment(c.id).then(function () {
              state.comments = state.comments.filter(function (x) { return x.id !== c.id; });
              refresh();
            }, problem);
          })
        ])
      ]);
      return li;
    });
    body.appendChild(section('Comments', comments.length, comments, 'None yet. Tap anything on the page to leave one.'));

    /* wording */
    var edits = state.edits.map(function (e) {
      return h('li', { class: 'rv-item' }, [
        h('p', { class: 'rv-item__meta', text: e.label + ' · ' + e.what + ' · ' + e.by + (e.applied ? '' : ' · saved, not shown on the page') }),
        h('p', { class: 'rv-old', dir: 'auto', text: e.original }),
        h('p', { class: 'rv-new', dir: 'auto', text: e.suggested }),
        h('div', { class: 'rv-row' }, [
          button('Show', 'rv-btn--tiny', function () { jump(resolve(e.rid)); }),
          button('Put the original back', 'rv-btn--tiny rv-btn--danger', function () { removeEdit(e.rid); })
        ])
      ]);
    });
    body.appendChild(section('New wording', edits.length, edits, 'None yet. Tap a line of text, then Suggest new wording.'));

    /* pictures */
    var pictures = Object.keys(state.images).filter(function (k) { return k.indexOf('img:') === 0; }).map(function (key) {
      var meta = state.images[key];
      return h('li', { class: 'rv-item rv-item--pic' }, [
        h('img', { src: urls[key], alt: '' }),
        h('div', null, [
          h('p', { class: 'rv-item__meta', text: (meta.label || 'Page') + ' · ' + (meta.by || '') }),
          h('p', { class: 'rv-item__text', dir: 'auto', text: 'Replaces: ' + (meta.alt || 'picture') }),
          h('div', { class: 'rv-row' }, [
            button('Show', 'rv-btn--tiny', function () { jump(resolve(key.slice(4))); }),
            button('Put the original back', 'rv-btn--tiny rv-btn--danger', function () { removeImage(key); })
          ])
        ])
      ]);
    });
    body.appendChild(section('Pictures replaced', pictures.length, pictures, 'None yet. Tap any picture to swap it.'));

    /* still needed */
    var needs = needItems();
    var doneCount = needs.filter(function (n) { return n.done; }).length;
    var needNodes = needs.map(function (item) {
      return h('li', { class: 'rv-need' + (item.done ? ' is-done' : '') }, [
        h('button', { type: 'button', class: 'rv-need__btn', onclick: function () { jump(item.el); } }, [
          h('span', { class: 'rv-need__code', text: item.done ? '✓' : item.need }),
          h('span', null, [
            h('b', { text: item.title }),
            h('span', { dir: 'auto', text: item.done ? item.value : item.ask })
          ])
        ])
      ]);
    });
    body.appendChild(h('section', { class: 'rv-group' }, [
      h('h3', { class: 'rv-group__title' }, ['Still needed from you', h('span', { text: doneCount + ' of ' + needs.length })]),
      h('ul', { class: 'rv-list' }, needNodes)
    ]));

    /* actions */
    body.appendChild(h('div', { class: 'rv-actions' }, [
      button('Send feedback', 'rv-btn--main rv-btn--big', sendFeedback),
      h('p', { class: 'rv-help', text: 'Makes one file with everything above, pictures included. Send that file to Adib.' }),
      h('div', { class: 'rv-row' }, [
        button('Copy a text summary', 'rv-btn--quiet', copySummary),
        button('Load a feedback file', 'rv-btn--quiet', loadFile),
        button('Erase everything', 'rv-btn--quiet rv-btn--danger', eraseAll)
      ])
    ]));
    body.scrollTop = keepScroll;
  }

  /* ================= sending it ================= */
  function collect() {
    return store.exportAll().then(function (all) {
      return {
        kind: 'kalimat-feedback', version: 1, exportedAt: Date.now(),
        page: location.origin + location.pathname,
        reviewer: all.reviewer, comments: all.comments, edits: all.edits, slots: all.slots, images: all.images,
        needs: needItems().map(function (n) { return { need: n.need, title: n.title, ask: n.ask, done: n.done }; })
      };
    });
  }
  function slotText(entry) {
    var v = entry.value || {};
    switch (entry.kind) {
      case 'logos': return (v.items || []).map(function (i) { return i.name; }).join(', ');
      case 'quote': return '“' + (v.quote || '') + '” ' + [v.name, v.role].filter(Boolean).join(', ');
      case 'result': return [v.number, v.label].filter(Boolean).join(' ');
      case 'image': return 'Picture supplied';
      default: return v.text || '';
    }
  }
  function buildSummary(data) {
    var out = ['Kalimat website feedback', 'From: ' + (data.reviewer || 'not given') + ' · ' + when(data.exportedAt), data.page, ''];
    out.push('COMMENTS (' + data.comments.length + ')');
    data.comments.slice().sort(function (a, b) { return a.n - b.n; }).forEach(function (c) {
      out.push(c.n + '. [' + c.label + '] ' + c.what + ' “' + c.snippet + '”: ' + c.text + (c.resolved ? ' (resolved)' : ''));
    });
    out.push('', 'NEW WORDING (' + data.edits.length + ')');
    data.edits.forEach(function (e) { out.push('- [' + e.label + '] “' + e.original + '” -> “' + e.suggested + '”'); });
    var keys = Object.keys(data.slots);
    out.push('', 'CONTENT SUPPLIED (' + keys.length + ')');
    keys.forEach(function (k) { var s = data.slots[k]; out.push('- ' + s.need + ' ' + s.title + ': ' + slotText(s)); });
    var pics = data.images.filter(function (i) { return i.key.indexOf('img:') === 0; });
    out.push('', 'PICTURES REPLACED (' + pics.length + ')');
    pics.forEach(function (p) { out.push('- [' + (p.meta.label || 'Page') + '] ' + (p.meta.alt || 'picture') + ' -> ' + (p.meta.name || 'new picture')); });
    var missing = data.needs.filter(function (n) { return !n.done; });
    out.push('', 'STILL NEEDED (' + missing.length + ')');
    missing.forEach(function (n) { out.push('- ' + n.need + ' ' + n.title); });
    return out.join('\n');
  }
  // One self-contained page: readable on any device, and the raw data sits in
  // a JSON block at the end so it can be loaded back with "Load a feedback file".
  function buildReport(data) {
    function figure(image, caption) {
      return '<figure><img data-key="' + esc(image.key) + '" src="' + esc(image.dataUrl) + '" alt=""><figcaption>' + esc(caption) + '</figcaption></figure>';
    }
    var css = 'body{margin:0;padding:28px 18px 60px;background:#FFF8EC;color:#1C2748;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      'main{max-width:760px;margin:0 auto}h1{font-size:1.9rem;margin:0 0 6px}h2{margin:40px 0 12px;padding-top:18px;border-top:2px solid #1C2748;font-size:1.2rem}' +
      '.meta{color:#4F5873;margin:0 0 4px}.item{margin:0 0 14px;padding:14px 16px;border-radius:14px;background:#fff}.item p{margin:0 0 6px}.item p:last-child{margin:0}' +
      '.where{font-size:.85rem;color:#4F5873}.say{font-size:1.05rem}.old{text-decoration:line-through;color:#8A5A4C}.new{font-weight:600;color:#1C2748}' +
      '.tag{display:inline-block;margin-right:6px;padding:1px 8px;border-radius:99px;background:#FDE0D3;font-size:.78rem;font-weight:700}.done{background:#E9EBF2}' +
      'figure{margin:10px 0 0}figure img{max-width:100%;max-height:340px;border-radius:10px;border:1px solid #e3d9c4;background:#fff}figcaption{font-size:.82rem;color:#4F5873}' +
      'ul{padding-left:20px}.none{color:#4F5873}';
    var html = ['<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Kalimat website feedback, ' + esc(when(data.exportedAt)) + '</title><style>' + css + '</style></head><body><main>',
      '<h1>Kalimat website feedback</h1>',
      '<p class="meta">From <b dir="auto">' + esc(data.reviewer || 'name not given') + '</b> · ' + esc(when(data.exportedAt)) + '</p>',
      '<p class="meta">' + esc(data.page) + '</p>'];

    html.push('<h2>Comments (' + data.comments.length + ')</h2>');
    if (!data.comments.length) { html.push('<p class="none">None.</p>'); }
    data.comments.slice().sort(function (a, b) { return a.n - b.n; }).forEach(function (c) {
      html.push('<div class="item"><p class="where"><span class="tag' + (c.resolved ? ' done' : '') + '">#' + c.n + (c.resolved ? ' resolved' : '') + '</span>' +
        esc(c.label) + ' · ' + esc(c.what) + ' · <span dir="auto">“' + esc(c.snippet) + '”</span></p>' +
        '<p class="say" dir="auto">' + esc(c.text) + '</p><p class="where">' + esc(c.by) + ', ' + esc(when(c.at)) + '</p></div>');
    });

    html.push('<h2>New wording (' + data.edits.length + ')</h2>');
    if (!data.edits.length) { html.push('<p class="none">None.</p>'); }
    data.edits.forEach(function (e) {
      html.push('<div class="item"><p class="where">' + esc(e.label) + ' · ' + esc(e.what) + '</p><p class="old" dir="auto">' + esc(e.original) + '</p>' +
        '<p class="new" dir="auto">' + esc(e.suggested) + '</p><p class="where">' + esc(e.by) + ', ' + esc(when(e.at)) + '</p></div>');
    });

    var keys = Object.keys(data.slots).sort(function (a, b) { return needNumber(data.slots[a].need) - needNumber(data.slots[b].need); });
    html.push('<h2>Content supplied (' + keys.length + ')</h2>');
    if (!keys.length) { html.push('<p class="none">None.</p>'); }
    keys.forEach(function (k) {
      var s = data.slots[k];
      var pics = data.images.filter(function (i) { return i.key === 'slot:' + k || i.key.indexOf('slot:' + k + ':') === 0; });
      html.push('<div class="item"><p class="where"><span class="tag">' + esc(s.need) + '</span>' + esc(s.title) + ' · ' + esc(s.label || '') + '</p>' +
        '<p class="say" dir="auto">' + esc(slotText(s)) + '</p>' +
        pics.map(function (p) { return figure(p, p.meta.name || ''); }).join('') +
        '<p class="where">' + esc(s.by) + ', ' + esc(when(s.at)) + '</p></div>');
    });

    var replaced = data.images.filter(function (i) { return i.key.indexOf('img:') === 0; });
    html.push('<h2>Pictures replaced (' + replaced.length + ')</h2>');
    if (!replaced.length) { html.push('<p class="none">None.</p>'); }
    replaced.forEach(function (p) {
      html.push('<div class="item"><p class="where">' + esc(p.meta.label || 'Page') + ' · replaces “' + esc(p.meta.alt || 'picture') + '”</p>' +
        figure(p, (p.meta.name || '') + (p.meta.width ? ' · ' + p.meta.width + ' × ' + p.meta.height : '')) +
        '<p class="where">' + esc(p.meta.by || '') + ', ' + esc(when(p.meta.at)) + '</p></div>');
    });

    var missing = data.needs.filter(function (n) { return !n.done; });
    html.push('<h2>Still needed (' + missing.length + ' of ' + data.needs.length + ')</h2>');
    html.push(missing.length ? '<ul>' + missing.map(function (n) {
      return '<li><span class="tag">' + esc(n.need) + '</span><b>' + esc(n.title) + (/[.?!]$/.test(n.title) ? '' : '.') + '</b> ' + esc(n.ask) + '</li>';
    }).join('') + '</ul>' : '<p class="none">Nothing. Everything was supplied.</p>');

    // Pictures are already in the page above, so the data block carries only their details.
    var lean = JSON.parse(JSON.stringify(data));
    lean.images = lean.images.map(function (i) { return { key: i.key, meta: i.meta }; });
    html.push('</main><script type="application/json" id="kalimat-feedback">' + JSON.stringify(lean).replace(/</g, '\\u003c') + '</' + 'script></body></html>');
    return html.join('\n');
  }
  function fileName(ts) {
    var d = new Date(ts);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return 'kalimat-feedback-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + '.html';
  }
  function sendFeedback() {
    return collect().then(function (data) {
      var name = fileName(data.exportedAt);
      var blob = new Blob([buildReport(data)], { type: 'text/html' });
      var file = null;
      try { file = new File([blob], name, { type: 'text/html' }); } catch (err) { file = null; }
      var canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));

      function download() {
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: name, class: 'rv-sr' });
        ui.panel.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        toast('Saved as ' + name + '. Send that file to Adib.');
      }
      if (!canShare) { download(); return; }
      shell('Send feedback', name, [
        h('p', { class: 'rv-help', text: 'One file holds every comment, wording change and picture. Share it straight from here, or save it and send it later.' }),
        h('div', { class: 'rv-form' }, [
          button('Share the file', 'rv-btn--main', function () {
            navigator.share({ files: [file], title: 'Kalimat website feedback' }).then(closeSheet, function (err) {
              if (err && err.name !== 'AbortError') { download(); }
            });
          }),
          button('Save it on this device', '', function () { download(); closeSheet(); })
        ])
      ]);
      closePanel();
    }).catch(problem);
  }
  function copySummary() {
    return collect().then(function (data) {
      var text = buildSummary(data);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { toast('Summary copied. Pictures are only in the feedback file.'); });
      }
      var box = h('textarea', { class: 'rv-sr' });
      box.value = text;
      ui.panel.appendChild(box);
      box.select();
      var ok = doc.execCommand('copy');
      box.remove();
      toast(ok ? 'Summary copied. Pictures are only in the feedback file.' : 'Copying is blocked in this browser. Use Send feedback.', !ok);
      return null;
    }).catch(function () { toast('Copying is blocked in this browser. Use Send feedback.', true); });
  }
  // For Adib: open a client's feedback file to see the page exactly as they left it.
  function loadFile() {
    var input = h('input', { type: 'file', accept: '.html,text/html', class: 'rv-sr', tabindex: '-1' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) { return; }
      if (countAll() && !window.confirm('This replaces the feedback saved in this browser with the file. Continue?')) { return; }
      var reader = new FileReader();
      reader.onerror = function () { toast('That file could not be read.', true); };
      reader.onload = function () {
        var data;
        try {
          var parsed = new DOMParser().parseFromString(String(reader.result), 'text/html');
          var block = parsed.getElementById('kalimat-feedback');
          data = JSON.parse(block.textContent);
          if (data.kind !== 'kalimat-feedback') { throw new Error('wrong kind'); }
          var sources = {};
          $all('img[data-key]', parsed).forEach(function (img) { sources[img.getAttribute('data-key')] = img.getAttribute('src'); });
          data.images = (data.images || []).map(function (i) { return { key: i.key, meta: i.meta, dataUrl: sources[i.key] }; });
        } catch (err) {
          toast('That is not a Kalimat feedback file.', true);
          return;
        }
        store.importAll(data).then(function () { location.reload(); }, problem);
      };
      reader.readAsText(file);
    });
    ui.panel.appendChild(input);
    input.click();
  }
  function eraseAll() {
    if (!window.confirm('Erase every comment, wording change and picture saved in this browser? This cannot be undone.')) { return; }
    store.clearAll().then(function () { location.reload(); }, problem);
  }

  /* ================= switching the mode ================= */
  function setMode(next) {
    on = !!next;
    root.classList.toggle('is-review', on);
    ui.pill.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.count.hidden = !on;
    try { window.sessionStorage.setItem('kalimat-review-on-site-v2', on ? '1' : '0'); } catch (err) { /* not needed to work */ }
    if (on) {
      // Closed answers cannot be reviewed, so open them while review mode is on.
      openedDetails = $all('details:not([open])').filter(function (d) { return !d.closest('[data-rv]'); });
      openedDetails.forEach(function (d) { d.open = true; });
    } else {
      openedDetails.forEach(function (d) { d.open = false; });
      openedDetails = [];
      closeSheet();
      closePanel();
      ui.toast.hidden = true;
    }
    renderSlots();
    refresh();
    if (on && !persistent) {
      toast('This browser is not saving anything (private browsing, or storage is off). Tap Send feedback before you close this tab.', true);
    } else if (on && !hinted) {
      hinted = true;
      toast('Review mode is on. Tap anything to comment, reword it or swap a picture. Dashed boxes are things we still need from you.');
    }
  }

  function build() {
    ui.pill = h('button', { type: 'button', class: 'rv-pill', 'aria-pressed': 'false', title: 'Turn review mode on or off', onclick: function () { setMode(!on); } }, [
      h('i', { class: 'rv-pill__track', 'aria-hidden': 'true' }), 'Review'
    ]);
    ui.count = h('button', { type: 'button', class: 'rv-count', hidden: true, onclick: function () { if (ui.panel.hidden) { openPanel(); } else { closePanel(); } } });
    ui.bar = h('div', { class: 'rv-bar', 'data-rv': true }, [ui.pill, ui.count]);

    ui.hl = h('div', { class: 'rv-hl', hidden: true });
    ui.pins = h('div', { class: 'rv-pins' });
    ui.layer = h('div', { class: 'rv-layer', 'data-rv': true }, [ui.hl, ui.pins]);

    ui.sheetBody = h('div', { class: 'rv-sheet__body' });
    ui.sheet = h('div', { class: 'rv-sheet', 'data-rv': true, role: 'dialog', 'aria-label': 'Review this part of the page', hidden: true }, [ui.sheetBody]);

    ui.panelBody = h('div', { class: 'rv-panel__body' });
    ui.panel = h('aside', { class: 'rv-panel', 'data-rv': true, role: 'dialog', 'aria-label': 'Your feedback', hidden: true }, [ui.panelBody]);

    ui.toast = h('p', { class: 'rv-toast', 'data-rv': true, role: 'status', hidden: true });

    [ui.layer, ui.bar, ui.sheet, ui.panel, ui.toast].forEach(function (node) { doc.body.appendChild(node); });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { root.classList.add('rv-still'); }

    // In review mode a tap marks up the page instead of following links or sending forms.
    doc.addEventListener('click', function (e) {
      if (!on || !(e.target instanceof Element)) { return; }
      if (e.target.closest('[data-rv]')) { return; }
      if (e.target.closest('.switch')) { return; }      // the translated or written demo stays usable
      e.preventDefault();
      e.stopPropagation();
      var slot = e.target.closest('.slot');
      var el = slot || e.target.closest(PICK);
      if (el && el.matches('input, select, textarea')) { el = el.closest('.field') || el; }
      if (el) { openSheet(el); }
    }, true);
    doc.addEventListener('submit', function (e) {
      if (on && !(e.target instanceof Element && e.target.closest('[data-rv]'))) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    doc.addEventListener('mouseover', function (e) {
      if (!on || picked || !(e.target instanceof Element)) { return; }
      if (e.target.closest('[data-rv]')) { ui.hl.hidden = true; return; }
      var el = e.target.closest('.slot') || e.target.closest(PICK);
      if (el) { showHighlight(el); } else { ui.hl.hidden = true; }
    }, true);
    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !on) { return; }
      if (!ui.sheet.hidden) { closeSheet(); } else if (!ui.panel.hidden) { closePanel(); }
    });
    window.addEventListener('resize', queuePlace);
    window.addEventListener('scroll', queuePlace, { passive: true });
    window.addEventListener('load', queuePlace);
    if ('ResizeObserver' in window) { new ResizeObserver(queuePlace).observe(doc.body); }
  }

  /* ================= start ================= */
  store.init().then(function (info) {
    persistent = info.persistent;
    return store.getState();
  }).then(function (saved) {
    state.reviewer = saved.reviewer || '';
    state.comments = saved.comments || [];
    state.edits = saved.edits || [];
    state.slots = saved.slots || {};
    return Promise.all((saved.images || []).map(function (meta) {
      return store.getImage(meta.key).then(function (image) {
        if (!image) { return; }
        urls[meta.key] = URL.createObjectURL(image.blob);
        state.images[meta.key] = image.meta || {};
      });
    }));
  }).then(function () {
    // Saved changes show in normal mode too, so the client sees the page as they left it.
    state.edits.forEach(applyEdit);
    Object.keys(state.images).forEach(function (key) { if (key.indexOf('img:') === 0) { applyImage(key); } });
    build();
    var resume = false;
    try { resume = window.sessionStorage.getItem('kalimat-review-on-site-v2') === '1'; } catch (err) { resume = false; }
    if (resume) { hinted = true; }
    setMode(resume);
    window.KalimatReview = { collect: collect, buildReport: buildReport, buildSummary: buildSummary };
  }).catch(function (err) {
    if (window.console) { console.error('Review mode could not start', err); }
  });
})();
