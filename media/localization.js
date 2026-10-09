(() => {
  const bundle = JSON.parse(document.currentScript.dataset.l10n || '{}');
  globalThis.umjoonsicL10n = {
    t(message, ...args) {
      const translated = typeof bundle[message] === 'string' ? bundle[message] : message;
      const values = args.length === 1 && args[0] && typeof args[0] === 'object' ? args[0] : args;
      return translated.replace(/\{(\w+)\}/g, (match, key) =>
        Object.hasOwn(values, key) ? String(values[key]) : match);
    },
  };
})();
