/* Все внешние ссылки и переходы сайта — в этом файле.
   Меняйте значения здесь, остальные файлы берут их отсюда.

   sectorPage        — страница сектора Копрулу: куда ведёт переход с галактики
                       (квадрат на карте и пункт списка секторов).
   galaxyPage        — страница галактики: кнопка «к галактике» на странице сектора.
   sectorMapPreview  — превью подложки сектора, если тайлы не собраны. Сейчас
                       подложка своя: её собирает tools/build_assets.py в
                       assets/tiles.json + assets/map-preview.webp, поэтому поле
                       пустое и со сторонних доменов ничего не тянется.
*/
window.SITE_LINKS = {
  // Картинка карты галактики: локальный файл или внешняя ссылка (например, на GitHub)
  galaxyMapImage: '/assets/galaxy-map-2000.webp',
  sectorPage: '/sector/sector.html',
  galaxyPage: '/index.html',
  sectorMapPreview: ''
};
