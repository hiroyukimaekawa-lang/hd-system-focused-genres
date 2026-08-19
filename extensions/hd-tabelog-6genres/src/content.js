/**
 * content.js
 */

// 現在の一覧ページと同じエリア（都道府県＋エリアコード）配下のURLだけを許可する。
// 例: https://tabelog.com/chiba/C12234/rstLst/ → 許可プレフィックスは
//     https://tabelog.com/chiba/C12234/
// ジャンルバルーンの取得元を間違えた場合でも、他都道府県・他市区町村の
// リンクが紛れ込まないようにするための最終防御ライン。
function getTabelogAreaPrefix() {
  const m = window.location.href.match(/^(https:\/\/tabelog\.com\/[a-z]+\/[A-Za-z]\d+)\//);
  return m ? m[1] + '/' : null;
}

function addGenreLink(links, anchor, areaPrefix) {
  const href = (anchor.href || '').split('?')[0].split('#')[0];
  const name = anchor.textContent.trim().replace(/\s+/g, ' ');
  if (!href || !name) return;
  if (!/tabelog\.com/.test(href)) return;
  if (areaPrefix && !href.startsWith(areaPrefix)) return; // 別エリアのリンクは除外
  if (links.some(l => l.url === href)) return;
  links.push({ name, url: href });
}

async function revealTabelogGenreBalloon() {
  // 「すべて」など表示テキストだけでは市区町村バルーンと区別できないため、
  // 食べログの固定ID（js-leftnavi-genre-anchor）を最優先で狙う。
  const genreTarget =
    document.getElementById('js-leftnavi-genre-anchor') ||
    document.querySelector('[id*="genre-anchor"]') ||
    Array.from(document.querySelectorAll('.list-sidebar__item')).find(section => {
      const heading = section.querySelector('.list-sidebar__heading');
      return heading && /ジャンル/.test(heading.textContent || '');
    })?.querySelector('.list-sidebar__item-target');

  if (!genreTarget) return null;

  ['mouseover', 'mouseenter', 'mousemove'].forEach(type => {
    genreTarget.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  });

  await new Promise(resolve => setTimeout(resolve, 350));
  return genreTarget;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }

  if (message.action === 'GET_GENRE_LINKS') {
    (async () => {
      const siteType = message.siteType;
      const links = [];

      if (siteType === 'tabelog') {
        const areaPrefix = getTabelogAreaPrefix();
        const genreTarget = await revealTabelogGenreBalloon();

        // ① まずジャンルバルーン本体（js-leftnavi-genre-anchorが開くパネル）だけを見る。
        //    他のバルーン（市区町村など）を巻き込まないよう、コンテナIDで厳密にスコープする。
        const genreContainer =
          document.getElementById('js-leftnavi-genre-targets') ||
          document.getElementById('js-leftnavi-genre-scroll') ||
          (genreTarget && genreTarget.closest('.list-sidebar__item')) ||
          null;

        if (genreContainer) {
          genreContainer.querySelectorAll('.list-balloon__btn-list a[href], .list-balloon__table a[href]')
            .forEach(a => addGenreLink(links, a, areaPrefix));
        }

        // ② それでも見つからない場合のみ、ページ全体から探すフォールバック（同エリア限定）。
        if (links.length === 0) {
          document.querySelectorAll('.list-balloon__btn-list a[href]')
            .forEach(a => addGenreLink(links, a, areaPrefix));
        }

        if (links.length === 0) [
          '.list-sidebar__item-target a[href]',
          '.list-sidebar a[href*="/rstLst/"]',
          'a[href*="/rstLst/"]'
        ].forEach(selector => {
          document.querySelectorAll(selector).forEach(a => addGenreLink(links, a, areaPrefix));
        });

      } else if (siteType === 'hotpepper') {
        // .jscDropDownSideInner.boxSide は複数存在し、最初はエリア用(.linkReselectionList)
        // ジャンル用(.reselectionList)は2番目以降にあるため、document全体から直接検索する
        document.querySelectorAll('.reselectionList li a[href]').forEach(a => {
          const href = a.href.split('?')[0].split('#')[0];
          const name = a.textContent.trim().replace(/\s+/g, ' ');
          if (!href || !name) return;
          if (!/hotpepper\.jp/.test(href)) return;
          if (!/\/G\d+/.test(href)) return;
          if (links.some(l => l.url === href)) return;
          links.push({ name, url: href });
        });
      }

      sendResponse({ links });
    })();
    return true;
  }
});
