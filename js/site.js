/* Kalimat Middle East. Variation 5. No dependencies, no network requests. */
(function () {
  'use strict';

  /* ================================================================
     LAUNCH SWITCH
     true  = the "Review" pill is on the page and the client can leave
             comments, replace images, fill missing content and suggest
             wording. Their saved changes are also shown in normal mode.
     false = none of that exists. review.css, review-store.js and
             review.js are never downloaded. Set this for launch.
     ================================================================ */
  var REVIEW_MODE_ENABLED = true;

  // CONFIRM BEFORE LAUNCH: the WhatsApp number that should receive briefs.
  var WHATSAPP = 'https://wa.me/971556502009';
  var ASSET_VERSION = '6';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasIO = 'IntersectionObserver' in window;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- Header hairline once the page scrolls ---------- */
  var top = $('.top');
  if (top) {
    var onScroll = function () { top.classList.toggle('is-stuck', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Hero: the poster stack deals a new line every few seconds ---------- */
  // Each poster shows the brief, the word-for-word Arabic struck out, then the written line.
  var stack = $('#stack');
  if (stack && !reduceMotion) {
    var posters = $all('.poster', stack);
    var stackTimer = null;
    var place = function () { posters.forEach(function (p, i) { p.setAttribute('data-pos', String(i)); }); };
    var play = function (p) {
      posters.forEach(function (x) { x.classList.remove('is-played'); });
      void p.offsetWidth;                     // restart the CSS animations
      p.classList.add('is-played');
    };
    var deal = function () {
      if (document.documentElement.classList.contains('is-review')) { return; }   // hold still while the client marks up the page
      var leaving = posters[0];
      leaving.classList.add('is-leaving');
      setTimeout(function () {
        posters.push(posters.shift());
        leaving.classList.add('is-jump');
        leaving.classList.remove('is-leaving');
        place();
        play(posters[0]);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { leaving.classList.remove('is-jump'); });
        });
      }, 480);
    };
    var startStack = function () { if (!stackTimer) { stackTimer = setInterval(deal, 5200); } };
    var stopStack = function () { clearInterval(stackTimer); stackTimer = null; };
    play(posters[0]);
    if (hasIO) {
      new IntersectionObserver(function (e) { if (e[0].isIntersecting) { startStack(); } else { stopStack(); } }, { threshold: 0.2 }).observe(stack);
    } else {
      startStack();
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) { stopStack(); } else { startStack(); } });
  }

  /* ---------- The switch: the same three briefs, translated or written ---------- */
  var diff = $('#difference');
  if (diff) {
    var radios = $all('.switch input', diff);
    var autoFlip = null;
    var setMode = function (mode) {
      diff.setAttribute('data-mode', mode);
      radios.forEach(function (r) { r.checked = (r.value === mode); });
    };
    var stopAuto = function () { if (autoFlip) { clearInterval(autoFlip); autoFlip = null; } };
    radios.forEach(function (r) {
      r.addEventListener('change', function () { stopAuto(); diff.setAttribute('data-touched', 'true'); setMode(r.value); });
      r.addEventListener('click', function () { stopAuto(); diff.setAttribute('data-touched', 'true'); });
    });
    // Until someone touches it, the switch flips by itself while it is on screen.
    if (hasIO && !reduceMotion) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (diff.getAttribute('data-touched')) { return; }
          if (entry.isIntersecting && !autoFlip) {
            setMode('literal');
            setTimeout(function () { if (!diff.getAttribute('data-touched')) { setMode('written'); } }, 1500);
            autoFlip = setInterval(function () {
              if (document.documentElement.classList.contains('is-review')) { return; }
              setMode(diff.getAttribute('data-mode') === 'written' ? 'literal' : 'written');
            }, 3400);
          } else if (!entry.isIntersecting) {
            stopAuto();
            setMode('written');
          }
        });
      }, { threshold: 0.3 }).observe(diff);
    }
  }

  /* ---------- Counters: the real number is in the HTML, the count-up is a bonus ---------- */
  function formatCount(n, group) { return group ? n.toLocaleString('en-US') : String(n); }
  function runCounter(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    var group = el.getAttribute('data-group') === 'true';
    var from = target > 1000 && !group ? target - 30 : 0;   // years tick up from close by
    var start = null;
    var done = false;
    function finish() { done = true; el.textContent = formatCount(target, group); }
    function frame(ts) {
      if (done) { return; }
      if (start === null) { start = ts; }
      var t = Math.min((ts - start) / 1400, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = formatCount(Math.round(from + (target - from) * eased), group);
      if (t < 1) { requestAnimationFrame(frame); } else { finish(); }
    }
    requestAnimationFrame(frame);
    setTimeout(finish, 2200);   // a background tab can stall the animation, never the number
  }

  /* ---------- Scroll reveals ---------- */
  var reveals = $all('.reveal');
  // Neighbours arrive one after another.
  reveals.forEach(function (el) {
    var sibs = Array.prototype.filter.call(el.parentNode.children, function (c) { return c.classList.contains('reveal'); });
    var i = sibs.indexOf(el);
    if (i > 0) { el.style.setProperty('--d', Math.min(i, 5) * 0.09 + 's'); }
  });
  if (hasIO && !reduceMotion) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); revealObserver.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    reveals.forEach(function (el) { revealObserver.observe(el); });

    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { runCounter(entry.target); countObserver.unobserve(entry.target); }
      });
    }, { threshold: 0.4 });
    $all('[data-count]').forEach(function (el) { countObserver.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---------- Phones: keep the button in reach between the hero and the form ---------- */
  var dock = $('#dock');
  var heroCta = $('#hero-cta');
  var briefSection = $('#brief');
  if (dock && heroCta && briefSection && hasIO) {
    dock.hidden = false;
    var heroSeen = true;
    var briefSeen = false;
    var paintDock = function () { dock.classList.toggle('is-on', !heroSeen && !briefSeen); };
    new IntersectionObserver(function (e) { heroSeen = e[0].isIntersecting; paintDock(); }).observe(heroCta);
    new IntersectionObserver(function (e) { briefSeen = e[0].isIntersecting; paintDock(); }, { threshold: 0.05 }).observe(briefSection);
  }

  /* ---------- Brief form: validate, open WhatsApp prefilled, show success ---------- */
  var form = $('#brief-form');
  var success = $('#brief-success');
  var fallback = $('#brief-fallback');

  function setError(input, show) {
    var msg = document.getElementById(input.getAttribute('aria-describedby'));
    if (show) { input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
    if (msg) { msg.hidden = !show; }
  }
  function validContact(value) {
    var v = value.trim();
    var isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    var isPhone = /^[+\d][\d\s().-]*$/.test(v) && v.replace(/\D/g, '').length >= 7;
    return isEmail || isPhone;
  }

  if (form && success) {
    var nameEl = $('#f-name');
    var contactEl = $('#f-contact');

    [nameEl, contactEl].forEach(function (input) {
      input.addEventListener('input', function () {
        if (input.getAttribute('aria-invalid') === 'true') { setError(input, false); }
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var nameOk = nameEl.value.trim().length > 0;
      var contactOk = validContact(contactEl.value);
      setError(nameEl, !nameOk);
      setError(contactEl, !contactOk);
      if (!nameOk) { nameEl.focus(); return; }
      if (!contactOk) { contactEl.focus(); return; }

      var brief = $('#f-brief').value.trim();
      var lines = ['Hello Kalimat, here is my brief.', 'Name: ' + nameEl.value.trim()];
      lines.push('Email or phone: ' + contactEl.value.trim());
      lines.push('What I need: ' + $('#f-service').value);
      if (brief) { lines.push('Brief: ' + brief); }

      var url = WHATSAPP + '?text=' + encodeURIComponent(lines.join('\n'));
      var isBot = $('#f-website').value !== '';   // honeypot: people never fill this

      if (!isBot) {
        fallback.href = url;
        var win = window.open(url, '_blank');
        if (win) { win.opener = null; }
      }

      form.hidden = true;
      success.hidden = false;
      success.focus();
    });
  }

  /* ---------- Review mode: loaded only when the launch switch is on ---------- */
  if (REVIEW_MODE_ENABLED) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'css/review.css?v=' + ASSET_VERSION;
    document.head.appendChild(css);
    ['js/review-store.js', 'js/review.js'].forEach(function (src) {
      var s = document.createElement('script');
      s.src = src + '?v=' + ASSET_VERSION;
      s.async = false;                         // keep the order: store first, then the interface
      document.body.appendChild(s);
    });
  }
})();
