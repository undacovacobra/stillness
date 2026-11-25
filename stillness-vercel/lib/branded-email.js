const colors = {
  page: '#201510',
  card: '#2a1b15',
  ink: '#fff0df',
  soft: '#e5cdbb',
  gold: '#efc8a9',
  line: '#684a3b',
};

const serif = "Georgia,'Times New Roman',serif";
const sans = "Arial,Helvetica,sans-serif";

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}

function httpsLink(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && !target.username && !target.password ? target.href : '';
  } catch {
    return '';
  }
}

function actionLink(label, url) {
  return '<p style="margin:24px 0"><a href="' + escapeHtml(url) + '" style="display:inline-block;padding:13px 22px;' +
    'border-radius:5px;background:' + colors.gold + ';color:' + colors.page +
    ';font-weight:700;text-decoration:none">' + escapeHtml(label) + '</a></p>';
}

function messageBody(text, links) {
  return text.split(/\n{2,}/).flatMap(block => {
    const content = [];
    let lines = [];
    const paragraph = () => {
      if (!lines.length) return;
      content.push('<p style="margin:0 0 15px">' + lines.map(escapeHtml).join('<br>') + '</p>');
      lines = [];
    };
    for (const line of block.split('\n')) {
      const url = httpsLink(line.trim());
      if (!url || !links.has(url)) {
        lines.push(line);
      } else {
        paragraph();
        content.push(actionLink(links.get(url), url));
      }
    }
    paragraph();
    return content;
  }).join('');
}

export function brandedEmail({ subject, origin, body, greeting, actions = {}, footer }) {
  const site = httpsLink(origin);
  const picture = site ? new URL('/design/dusk-water.jpg', site).href : '';
  const links = new Map(Object.entries(actions).map(([url, label]) => [httpsLink(url), label]));
  const bodyHtml = messageBody(body, links);
  const consentUrl = httpsLink(footer?.unsubscribeUrl);
  const footerHtml = footer ? '<div style="margin-top:16px">' +
    (consentUrl ? '<a style="color:' + colors.gold + '" href="' + escapeHtml(consentUrl) +
      '">Unsubscribe from Stillness offers</a>' : 'Unsubscribe from Stillness offers') +
    '<br>' + escapeHtml(footer.postalAddress).replace(/\r?\n/g, '<br>') + '</div>' : '';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">',
    '<title>' + escapeHtml(subject) + '</title></head>',
    '<body style="margin:0;background:' + colors.page + ';color:' + colors.ink + '">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + colors.page + '">',
    '<tr><td align="center" style="padding:28px 12px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + colors.card +
      '" style="max-width:576px;border:1px solid ' + colors.line + ';border-radius:8px;overflow:hidden">',
    '<tr><td style="padding:20px 28px;font:24px ' + serif + ';color:' + colors.gold + '">Stillness</td></tr>',
    picture ? '<tr><td><img alt="" src="' + escapeHtml(picture) +
      '" width="576" height="112" style="display:block;width:100%;height:112px;object-fit:cover;background:#53352a"></td></tr>' : '',
    '<tr><td style="padding:28px;color:' + colors.ink + ';font:16px/1.65 ' + sans + '">',
    '<h1 style="margin:0 0 18px;font:normal 32px/1.2 ' + serif + ';color:' + colors.ink + '">' + escapeHtml(subject) + '</h1>',
    greeting ? '<p style="margin:0 0 15px">' + escapeHtml(greeting) + '</p>' : '',
    bodyHtml + '</td></tr>',
    '<tr><td style="padding:16px 28px 24px;border-top:1px solid ' + colors.line + ';color:' +
      colors.soft + ';font:13px/1.55 ' + sans + '">Stillness' + footerHtml + '</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}
