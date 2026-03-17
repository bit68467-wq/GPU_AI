/*
 profile-actions-ui.js — small action buttons for profile
*/
import { auth } from './auth.js';
import { notify } from './notifications.js';

export function renderProfileActions(container){
  container.innerHTML = '';
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'btn secondary';
  logoutBtn.textContent = 'Logout';
  logoutBtn.onclick = async ()=>{
    await auth.logout();
    notify('ui:navigate','login');
  };

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn';
  refreshBtn.textContent = 'Refresh Profile';
  refreshBtn.onclick = ()=> notify('profile:refresh');

  container.appendChild(refreshBtn);
  container.appendChild(logoutBtn);
}