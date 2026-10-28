// Runs in the page's MAIN world at document_start, before any page script.
// Registered (by registry.js) only for enabled hosts. Replaces Date (and
// friends) with a clock shifted to the configured time. Config is read
// synchronously from localStorage (mirrored there by bridge.js and the popup)
// so the very first Date.now() the page calls is already fake.
(() => {
  'use strict';

  const KEY = '__countdown_peek__';
  const EVT = '__countdown_peek_update__';
  const GUARD = Symbol.for(EVT);

  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  const NativeDate = Date;
  const nativeNow = NativeDate.now;

  // Same rule as bridge.js: config belongs to the top-level page's host.
  const topHost = (() => {
    if (window === window.top) return location.hostname;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        return new URL(ao[ao.length - 1]).hostname;
      } catch {}
    }
    try {
      return window.top.location.hostname;
    } catch {
      return location.hostname;
    }
  })();

  let enabled = false;
  let startReal = 0;
  let startFake = 0;
  let installed = false;

  function now() {
    return enabled ? startFake + (nativeNow() - startReal) : nativeNow();
  }

  function apply(cfg) {
    // The localStorage copy is per origin and same-site frames share it, so
    // only trust a config written for this page's top-level host.
    if (!cfg || !cfg.enabled || cfg.host !== topHost) {
      enabled = false;
      return;
    }
    const real = nativeNow();
    startReal = real;
    startFake = cfg.mode === 'offset' ? real + Number(cfg.offset || 0) : Number(cfg.target);
    enabled = Number.isFinite(startFake);
    if (enabled) install();
  }

  function install() {
    if (installed) return;
    installed = true;

    // Keep patched functions looking native to Function.prototype.toString.
    const fnToString = Function.prototype.toString;
    const disguised = new WeakMap();
    const disguise = (fake, real) => {
      disguised.set(fake, fnToString.call(real));
      return fake;
    };
    const toString = {
      toString() {
        return disguised.has(this) ? disguised.get(this) : fnToString.call(this);
      },
    }.toString;
    disguise(toString, fnToString);
    Function.prototype.toString = toString;

    const getterOf = (obj, name) => Object.getOwnPropertyDescriptor(obj, name).get;
    const method = (obj, name, fn) =>
      Object.defineProperty(obj, name, { value: fn, writable: true, enumerable: false, configurable: true });

    // --- Date -------------------------------------------------------------
    function FakeDate(...args) {
      if (!new.target) return NativeDate.prototype.toString.call(new NativeDate(now()));
      return Reflect.construct(NativeDate, args.length ? args : [now()], new.target);
    }
    Object.defineProperties(FakeDate, {
      name: { value: 'Date' },
      length: { value: NativeDate.length },
      prototype: { value: NativeDate.prototype, writable: false, enumerable: false, configurable: false },
    });
    const statics = {
      now() {
        return Math.floor(now());
      },
    };
    method(FakeDate, 'now', disguise(statics.now, nativeNow));
    method(FakeDate, 'parse', NativeDate.parse);
    method(FakeDate, 'UTC', NativeDate.UTC);
    method(NativeDate.prototype, 'constructor', FakeDate);
    disguise(FakeDate, NativeDate);
    window.Date = FakeDate;

    // --- Intl.DateTimeFormat: format()/formatToParts() with no argument ------
    const DTF = Intl.DateTimeFormat.prototype;
    const formatDesc = Object.getOwnPropertyDescriptor(DTF, 'format');
    if (formatDesc && formatDesc.get) {
      const origGet = formatDesc.get;
      const cache = new WeakMap();
      const getter = getterOf(
        {
          get format() {
            if (!cache.has(this)) {
              const f = origGet.call(this);
              cache.set(this, (date) => f(date === undefined ? now() : date));
            }
            return cache.get(this);
          },
        },
        'format',
      );
      Object.defineProperty(DTF, 'format', { ...formatDesc, get: disguise(getter, origGet) });
    }
    const origFormatToParts = DTF.formatToParts;
    if (origFormatToParts) {
      method(
        DTF,
        'formatToParts',
        disguise(
          {
            formatToParts(date) {
              return origFormatToParts.call(this, date === undefined ? now() : date);
            },
          }.formatToParts,
          origFormatToParts,
        ),
      );
    }

    // --- performance.timeOrigin (timeOrigin + performance.now() as "now") ---
    const originDesc = Object.getOwnPropertyDescriptor(Performance.prototype, 'timeOrigin');
    if (originDesc && originDesc.get) {
      const origOrigin = originDesc.get;
      const getter = getterOf(
        {
          get timeOrigin() {
            const v = origOrigin.call(this);
            return enabled ? v + (startFake - startReal) : v;
          },
        },
        'timeOrigin',
      );
      Object.defineProperty(Performance.prototype, 'timeOrigin', { ...originDesc, get: disguise(getter, origOrigin) });
    }

    // --- Server time read from the HTTP "Date" response header -------------
    // Only headers of real responses are shifted (fetch Response#headers and
    // XHR), never Headers objects the page builds itself.
    const shiftHttpDate = (v) => {
      if (!enabled || v == null) return v;
      const t = NativeDate.parse(v);
      return Number.isNaN(t) ? v : new NativeDate(t + (now() - nativeNow())).toUTCString();
    };
    const isDate = (name) => String(name).toLowerCase() === 'date';
    const responseHeaders = new WeakSet();
    const shifts = (headers) => enabled && responseHeaders.has(headers);

    const respDesc = Object.getOwnPropertyDescriptor(Response.prototype, 'headers');
    if (respDesc && respDesc.get) {
      const origHeaders = respDesc.get;
      const getter = getterOf(
        {
          get headers() {
            const h = origHeaders.call(this);
            if (h) responseHeaders.add(h);
            return h;
          },
        },
        'headers',
      );
      Object.defineProperty(Response.prototype, 'headers', { ...respDesc, get: disguise(getter, origHeaders) });
    }

    const HP = Headers.prototype;
    const origGet = HP.get;
    const origEntries = HP.entries;
    const origValues = HP.values;
    const origForEach = HP.forEach;
    method(
      HP,
      'get',
      disguise(
        {
          get(name) {
            const v = origGet.call(this, name);
            return isDate(name) && shifts(this) ? shiftHttpDate(v) : v;
          },
        }.get,
        origGet,
      ),
    );
    const entries = disguise(
      {
        *entries() {
          const it = origEntries.call(this);
          if (!shifts(this)) return yield* it;
          for (const [k, v] of it) yield [k, k === 'date' ? shiftHttpDate(v) : v];
        },
      }.entries,
      origEntries,
    );
    method(HP, 'entries', entries);
    if (HP[Symbol.iterator] === origEntries) method(HP, Symbol.iterator, entries);
    method(
      HP,
      'values',
      disguise(
        {
          *values() {
            if (!shifts(this)) return yield* origValues.call(this);
            for (const [k, v] of origEntries.call(this)) yield k === 'date' ? shiftHttpDate(v) : v;
          },
        }.values,
        origValues,
      ),
    );
    method(
      HP,
      'forEach',
      disguise(
        {
          forEach(cb, thisArg) {
            const shift = shifts(this);
            return origForEach.call(this, (v, k, h) => cb.call(thisArg, shift && k === 'date' ? shiftHttpDate(v) : v, k, h));
          },
        }.forEach,
        origForEach,
      ),
    );

    const XHR = XMLHttpRequest.prototype;
    const origGetHeader = XHR.getResponseHeader;
    const origGetAll = XHR.getAllResponseHeaders;
    method(
      XHR,
      'getResponseHeader',
      disguise(
        {
          getResponseHeader(name) {
            const v = origGetHeader.call(this, name);
            return isDate(name) ? shiftHttpDate(v) : v;
          },
        }.getResponseHeader,
        origGetHeader,
      ),
    );
    method(
      XHR,
      'getAllResponseHeaders',
      disguise(
        {
          getAllResponseHeaders() {
            const all = origGetAll.call(this);
            return enabled && all ? all.replace(/^(date:[ \t]*)(.*)$/im, (_, k, v) => k + shiftHttpDate(v)) : all;
          },
        }.getAllResponseHeaders,
        origGetAll,
      ),
    );

    // --- Temporal.Now (if the browser ships it) ----------------------------
    const T = globalThis.Temporal;
    if (T && T.Now && T.Instant) {
      const tzId = T.Now.timeZoneId ? T.Now.timeZoneId.bind(T.Now) : () => 'UTC';
      const instant = () => T.Instant.fromEpochMilliseconds(Math.floor(now()));
      const zoned = (tz) => instant().toZonedDateTimeISO(tz === undefined ? tzId() : tz);
      const patch = {
        instant() {
          return instant();
        },
        zonedDateTimeISO(tz) {
          return zoned(tz);
        },
        plainDateTimeISO(tz) {
          return zoned(tz).toPlainDateTime();
        },
        plainDateISO(tz) {
          return zoned(tz).toPlainDate();
        },
        plainTimeISO(tz) {
          return zoned(tz).toPlainTime();
        },
      };
      for (const [name, fn] of Object.entries(patch)) {
        const orig = T.Now[name];
        if (typeof orig !== 'function') continue;
        try {
          Object.defineProperty(fn, 'length', { value: orig.length });
          method(T.Now, name, disguise(fn, orig));
        } catch {}
      }
    }
  }

  let initial = null;
  try {
    initial = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {}
  apply(initial);

  // Live updates from bridge.js / popup (detail is a JSON string or null).
  window.addEventListener(EVT, (e) => {
    let cfg = null;
    try {
      cfg = JSON.parse(e.detail || 'null');
    } catch {}
    apply(cfg);
  });
})();
