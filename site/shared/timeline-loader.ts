/* Единый экран загрузки для всех страниц атласа (галактика, сектор, будущие области).
   Подключается синхронно сразу после <body>: вставляет одну и ту же разметку на своём месте.
   Тексты задаются здесь и только здесь, поэтому загрузка одинаковая на любом этапе. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var markup =
    '<div class="timeline-loader" id="timelineLoader" role="status" aria-live="polite" aria-label="Загрузка атласа Timeline Project">' +
      '<div class="timeline-loader-core">' +
        '<img class="timeline-loader-logo" src="/assets/timeline-project-logo.webp" alt="Timeline Project" width="600" height="600" fetchpriority="high" decoding="async">' +
        '<div class="timeline-loader-progress" aria-hidden="true"></div>' +
        '<div class="timeline-loader-meta">sector · registry · secure link</div>' +
      '</div>' +
    '</div>';
  script.insertAdjacentHTML('beforebegin', markup);
})();
