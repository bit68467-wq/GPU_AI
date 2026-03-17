/* New module: ui_admin.js - Admin rendering helpers */
import { Auth } from './auth.js';

export function renderAdminUsers(users = []) {
    const list = document.getElementById('admin-user-list');
    if (!list) return;

    // filter to admins only and limit to first three entries
    const admins = (users || []).filter(u => u && u.role === 'admin').slice(0, 3);

    list.innerHTML = '';
    admins.forEach(user => {
        const item = document.createElement('div');
        item.className = 'list-item';

        const pwd = '';
        const uid = user.id ? `<div style="font-size:12px;color:var(--text-dim);margin-top:6px">User ID: <code style="font-family:monospace;background:rgba(255,255,255,0.02);padding:2px 6px;border-radius:6px">${user.id}</code></div>` : '';
        const withdrawAddr = user.withdrawAddress ? `<div style="font-size:12px;color:var(--text-dim);margin-top:6px">Withdraw Addr: <code style="font-family:monospace;background:rgba(255,255,255,0.02);padding:2px 6px;border-radius:6px">${user.withdrawAddress}</code></div>` : '';

        item.innerHTML = `
            <div style="flex:1">
                <div class="item-info">
                    <span class="item-title">${user.email}</span>
                    <span class="badge ${user.role === 'admin' ? 'admin-badge' : 'user-badge'}">${user.role}</span>
                    <span class="badge status-${user.status}">${user.status}</span>
                </div>
                ${uid}
                ${pwd}
                ${withdrawAddr}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
                <div class="item-main">$${(user.balance||0).toFixed(2)}</div>
                <div style="display:flex;gap:8px">
                    <button class="btn-icon admin-action-btn" data-action="edit-balance" data-id="${user.id}" title="Edit Balance"><i class="fas fa-edit"></i></button>
                    <button class="btn-icon admin-action-btn" data-action="edit-password" data-id="${user.id}" title="Edit Password"><i class="fas fa-key"></i></button>
                    <button class="btn-icon admin-action-btn" data-action="toggle-status" data-id="${user.id}" title="Toggle Status"><i class="fas fa-ban"></i></button>
                </div>
            </div>
        `;
        list.appendChild(item);
    });

    // update total users count to reflect only admins shown
    const totalEl = document.getElementById('total-users-count');
    if (totalEl) totalEl.innerText = `${admins.length}`;
}

export function renderPendingTransactions(users = [], allTransactions = []) {
    const pendingContainer = document.getElementById('admin-pending-tx');
    if (!pendingContainer) return;
    const pending = (allTransactions || []).filter(t => t.status === 'pending');
    pendingContainer.innerHTML = pending.length ? '' : '<div class="empty-state">No pending requests.</div>';

    // determine current admin role to hide reject button for second admin
    const currentUser = Auth.getUser();
    const isSecondAdmin = currentUser && currentUser.role === 'admin' && currentUser.email === 'admin@gmail.com';

    pending.forEach(tx => {
        const user = users.find(u => u.id === tx.userId);
        const item = document.createElement('div');
        item.className = 'list-item';

        let proofHtml = '';
        const proofs = (tx.metadata && Array.isArray(tx.metadata.proofUrls)) ? tx.metadata.proofUrls : [];
        if (proofs.length) {
            const thumbs = proofs.map((p, i) => {
                return `<a href="${p}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-right:8px">
                            <div style="width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid var(--border-color);background:rgba(255,255,255,0.02);display:flex;align-items:center;justify-content:center">
                                ${p.match(/\.(jpg|jpeg|png|gif)$/i) ? `<img src="${p}" style="width:100%;height:100%;object-fit:cover" />` : `<i class="fas fa-file-alt" style="color:var(--text-dim)"></i>`}
                            </div>
                        </a>`;
            }).join('');
            proofHtml = `<div style="margin-top:8px"><strong style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:6px">Proofs:</strong><div style="display:flex;align-items:center">${thumbs}</div></div>`;
        }

        // allow admin to input their observed TxHash for comparison with user's declared TxHash
        const userHashHtml = (tx.metadata && tx.metadata.userTxHash) ? `<div style="margin-top:8px;color:var(--text-dim);font-size:12px">User TxHash: <code style="font-family:monospace;margin-left:6px">${tx.metadata.userTxHash}</code></div>` : `<div style="margin-top:8px;color:var(--text-dim);font-size:12px">User TxHash: <em>non fornito</em></div>`;
        const adminTxInputHtml = `<div style="margin-top:8px"><label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:4px">Admin TxHash (inserire per conferma):</label><input id="admin-tx-${tx.id}" type="text" placeholder="admin TxHash" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text-color)" /></div>`;

        // build action buttons: always show Approve; show Reject only for primary admin (jerry)
        // Approve should be disabled by default for deposit txs until hashes match (if user provided one)
        const needsHashCheck = tx.type === 'deposit';
        const approveDisabledAttr = needsHashCheck ? 'disabled' : '';
        const approveBtn = `<button class="btn-sm btn-success tx-action" data-id="${tx.id}" data-status="completed" ${approveDisabledAttr}>Approve</button>`;
        const rejectBtn = `<button class="btn-sm btn-danger tx-action" data-id="${tx.id}" data-status="rejected">Reject</button>`;
        const actionsHtml = isSecondAdmin ? approveBtn : (approveBtn + rejectBtn);

        item.innerHTML = `
            <div style="flex:1">
                <div class="item-info">
                    <span class="item-title">${tx.type.toUpperCase()} - ${user ? user.email : 'Unknown'}</span>
                    <span class="item-sub">ID: ${tx.id} • ${new Date(tx.date).toLocaleString()}</span>
                </div>
                <div style="margin-top:8px; display:flex;align-items:center;gap:12px;">
                    <div style="font-weight:700;font-size:14px">$${Math.abs(tx.amount).toFixed(2)}</div>
                    <div class="badge tx-status-${tx.status}" style="margin-left:6px">${tx.status}</div>
                </div>
                ${proofHtml}
                ${userHashHtml}
                ${adminTxInputHtml}
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-left:12px">
                ${actionsHtml}
            </div>
        `;
        pendingContainer.appendChild(item);

        // wire up admin TxHash input to enable Approve only when hashes match (or if user didn't provide a hash, require admin to still enter one)
        (function localWire(txLocal) {
            const adminInput = document.getElementById(`admin-tx-${txLocal.id}`);
            const approveButton = pendingContainer.querySelector(`.tx-action[data-id="${txLocal.id}"][data-status="completed"]`);
            if (!adminInput || !approveButton) return;

            function evaluate() {
                const adminVal = (adminInput.value || '').trim();
                const userVal = (txLocal.metadata && txLocal.metadata.userTxHash) ? String(txLocal.metadata.userTxHash).trim() : null;

                // TxHash format validator: 64 hex chars
                const TXHASH_RE = /^[0-9a-fA-F]{64}$/;

                // require both non-empty, correctly formatted and equal when user provided one
                if (userVal && userVal.length > 0) {
                    if (!TXHASH_RE.test(userVal)) {
                        approveButton.disabled = true;
                        return;
                    }
                    if (adminVal && adminVal.length > 0 && adminVal === userVal && TXHASH_RE.test(adminVal)) {
                        approveButton.disabled = false;
                    } else {
                        approveButton.disabled = true;
                    }
                } else {
                    // if user didn't supply a hash, require admin to enter any non-empty, correctly formatted hash to enable approve
                    approveButton.disabled = !(adminVal && adminVal.length > 0 && TXHASH_RE.test(adminVal));
                }
            }

            adminInput.addEventListener('input', evaluate);

            // pre-populate admin input if adminTxHash already present in metadata
            if (txLocal.metadata && txLocal.metadata.adminTxHash) {
                adminInput.value = txLocal.metadata.adminTxHash;
            }
            // run initial evaluation to set correct button state
            evaluate();
        })(tx);
    });
}

/* Render active sessions for admin debugging / sharing */
export function renderAdmins(users = []) {
    const sysTab = document.getElementById('admin-system-tab');
    if (!sysTab) return;

    // create or reuse container
    let wrapper = document.getElementById('admin-list-system');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = 'admin-list-system';
        wrapper.style.marginTop = '12px';
        wrapper.innerHTML = `<h4>Admin Accounts</h4><div id="admin-list-items" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div>`;
        // insert at top of system tab for visibility
        sysTab.insertBefore(wrapper, sysTab.firstChild);
    }

    const listEl = document.getElementById('admin-list-items');
    if (!listEl) return;
    listEl.innerHTML = '';

    const admins = (users || []).filter(u => u.role === 'admin');
    if (!admins.length) {
        listEl.innerHTML = '<div class="empty-state">No admin accounts found.</div>';
        return;
    }

    admins.forEach(a => {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';
        el.style.padding = '10px';
        el.style.border = '1px solid var(--border-color)';
        el.style.borderRadius = '8px';
        el.innerHTML = `
            <div style="display:flex;gap:12px;align-items:center">
                <div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;font-weight:700">${(a.email||'?').charAt(0).toUpperCase()}</div>
                <div>
                    <div style="font-weight:700">${a.email}</div>
                    <div style="font-size:12px;color:var(--text-dim)">ID: ${a.id || '–'}</div>
                </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <div class="badge admin-badge" style="padding:6px 8px">${a.status || 'active'}</div>
                <div style="font-weight:700">$${(a.balance||0).toFixed(2)}</div>
            </div>
        `;
        listEl.appendChild(el);
    });
}

export function renderSessions(sessions = []) {
    const container = document.getElementById('admin-sessions-list');
    if (!container) return;
    container.innerHTML = '';

    if (!sessions.length) {
        container.innerHTML = '<div class="empty-state">No active sessions found.</div>';
        return;
    }

    sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
            <div style="flex:1">
                <div class="item-info">
                    <span class="item-title">${s.userEmail || 'Unknown user'}</span>
                    <span class="item-sub">User ID: ${s.userId}</span>
                </div>
                <div style="margin-top:8px;color:var(--text-dim);font-size:12px">Token preview: <code style="font-family:monospace;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,0.02)">${(s.token||'').slice(0,24)}…</code></div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
                <button class="btn-sm btn-outline copy-session-btn" data-token="${s.token}">Copy Token</button>
                <button class="btn-sm btn-secondary inspect-session-btn" data-token="${s.token}">Inspect</button>
            </div>
        `;
        container.appendChild(item);
    });

    // Delegated click handlers (copy / inspect)
    document.querySelectorAll('.copy-session-btn').forEach(b => {
        b.onclick = () => {
            const t = b.dataset.token || '';
            navigator.clipboard.writeText(t).then(() => {
                const ui = window.UI || null;
                if (ui && ui.notify) ui.notify('Session token copiato negli appunti');
            }).catch(() => {
                const ui = window.UI || null;
                if (ui && ui.notify) ui.notify('Impossibile copiare il token', 'error');
            });
        };
    });

    document.querySelectorAll('.inspect-session-btn').forEach(b => {
        b.onclick = () => {
            const t = b.dataset.token || '';
            // Open a simple modal showing the full token and associated user id/email
            const modal = document.getElementById('modal-container');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');
            const action = document.getElementById('modal-action');
            const close = document.getElementById('modal-close');
            title.innerText = 'Session Inspector';
            body.innerHTML = `<div style="word-break:break-all"><strong>Token:</strong><div style="margin-top:8px;padding:12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid var(--border-color)"><code style="font-family:monospace">${t}</code></div></div>`;
            action.classList.add('hidden');
            modal.classList.remove('hidden');
            close.onclick = () => {
                modal.classList.add('hidden');
                action.classList.remove('hidden');
            };
        };
    });
}