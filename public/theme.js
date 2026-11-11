// Appearance: Auto (follows the device), Light or Dark. Runs before the page paints so there is no flash.
(function () {
  var KEY = 'veyraTheme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function choice() {
    try {
      var saved = localStorage.getItem(KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'auto';
    } catch (_) {
      return 'auto';
    }
  }
  function apply() {
    var value = choice();
    var dark = value === 'dark' || (value === 'auto' && media && media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme-choice', value);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#05071c' : '#0e1342');
    var buttons = document.querySelectorAll('[data-theme-choice][aria-pressed]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-choice') === value));
    }
  }
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('button[data-theme-choice]') : null;
      if (!button) return;
      try {
        localStorage.setItem(KEY, button.getAttribute('data-theme-choice'));
      } catch (_) { /* private mode: the choice lasts for this page only */ }
      apply();
      event.stopPropagation();
    });
  });
}());
