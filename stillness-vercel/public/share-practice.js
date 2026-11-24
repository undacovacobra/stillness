const panel = document.querySelector('[data-share-practice]');
const canonical = document.querySelector('link[rel="canonical"]')?.href;

if (panel && canonical) {
  const shareButton = panel.querySelector('button');
  const status = panel.querySelector('[role="status"]');
  const copyField = panel.querySelector('input');
  const shareTitle = document.querySelector('meta[property="og:title"]')?.content || document.title;
  panel.hidden = false;

  shareButton.addEventListener('click', async () => {
    status.textContent = '';
    copyField.hidden = true;
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url: canonical });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(canonical);
      status.textContent = 'Link copied.';
    } catch {
      copyField.value = canonical;
      copyField.hidden = false;
      copyField.select();
      status.textContent = 'Copy the link above.';
    }
  });
}
