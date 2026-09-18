  async function loadAdmin() {
    const content = document.getElementById('adminContent');
    content.innerHTML = '<div class="empty-small">Загрузка...</div>';
    try {
      const users = await apiAdmin('/admin/users', { method: 'POST', body: JSON.stringify({}) });

      const header = `
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
          <button id="purgeNoPassBtn" style="flex:1;padding:10px;font-size:12.5px;border-radius:10px;cursor:pointer;font-family:inherit;background:rgba(255,80,100,0.15);border:1px solid rgba(255,90,110,0.5);color:#ff9aa7;transition:all 0.25s;">
            🗑 Удалить все анкеты без паролей
          </button>
          <button id="refreshAdminBtn" style="flex:1;padding:10px;font-size:12.5px;border-radius:10px;cursor:pointer;font-family:inherit;background:rgba(60,60,78,0.55);border:1px solid rgba(255,255,255,0.12);color:#e8e8f0;transition:all 0.25s;">
            🔄 Обновить
          </button>
        </div>
      `;

      const rows = users.map(u => {
        const av = u.photo ? `<img src="${u.photo}" alt="">` : `<div class="mini-avatar">✦</div>`;
        return `
          <div class="admin-user-row">
            ${av}
            <div class="admin-user-info">
              <strong>${escapeHtml(u.name)}, ${u.age} ${u.is_premium ? '⭐' : ''}</strong>
              <small>ID: ${u.id} · 🪙 ${u.vide} · ♥ ${u.likes}</small>
            </div>
            <div class="admin-actions">
              <input type="number" id="amt_${u.id}" value="100">
              <button class="give" data-action="give" data-id="${u.id}">Дать 🪙</button>
              <button class="premium" data-action="premium" data-id="${u.id}">${u.is_premium ? 'Снять ⭐' : 'Дать ⭐'}</button>
              <button class="danger" data-action="del" data-id="${u.id}">Удалить</button>
            </div>
          </div>
        `;
      }).join('');

      content.innerHTML = header + rows;

      document.getElementById('purgeNoPassBtn').addEventListener('click', async () => {
        if (!confirm('Удалить ВСЕ анкеты без паролей? Это старые и вредительские аккаунты. Действие необратимо.')) return;
        const btn = document.getElementById('purgeNoPassBtn');
        btn.disabled = true;
        btn.textContent = 'Удаляем...';
        try {
          const r = await apiAdmin('/admin/purge-nopass', { method: 'POST', body: JSON.stringify({}) });
          alert(`Удалено анкет: ${r.deleted}`);
          await loadAdmin();
          await loadWall();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
          btn.textContent = '🗑 Удалить все анкеты без паролей';
        }
      });

      document.getElementById('refreshAdminBtn').addEventListener('click', () => loadAdmin());

      content.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = parseInt(btn.dataset.id);
          const action = btn.dataset.action;
          try {
            if (action === 'give') {
              const amt = parseInt(document.getElementById('amt_' + id).value);
              await apiAdmin('/admin/give-vide', { method: 'POST', body: JSON.stringify({ userId: id, amount: amt }) });
            } else if (action === 'premium') {
              await apiAdmin('/admin/toggle-premium', { method: 'POST', body: JSON.stringify({ userId: id }) });
            } else if (action === 'del') {
              if (!confirm('Удалить анкету навсегда?')) return;
              await apiAdmin('/admin/delete-user', { method: 'POST', body: JSON.stringify({ userId: id }) });
            }
            await loadAdmin();
            loadWall();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      content.innerHTML = `<div class="form-status error">${escapeHtml(err.message)}</div>`;
      setAdminToken(null);
    }
  }
