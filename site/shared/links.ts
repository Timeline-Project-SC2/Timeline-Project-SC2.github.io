/* Все внешние ссылки и переходы сайта — в этом файле.
   Меняйте значения здесь, остальные файлы берут их отсюда.

   sectorPage        — страница сектора Копрулу: куда ведёт переход с галактики
                       (квадрат на карте и пункт списка секторов).
   galaxyPage        — страница галактики: кнопка «к галактике» на странице сектора.
*/

export interface SiteLinks {
  readonly galaxyMapImage: string;
  readonly sectorPage: string;
  readonly galaxyPage: string;
}

declare global {
  interface Window {
    SITE_LINKS: SiteLinks;
  }
}

const siteLinks: SiteLinks = {
  // Картинка карты галактики: локальный файл или внешняя ссылка (например, на GitHub)
  galaxyMapImage: '/assets/galaxy-map-2000.webp',
  sectorPage: '/sector/sector.html',
  galaxyPage: '/index.html',
};

window.SITE_LINKS = siteLinks;
