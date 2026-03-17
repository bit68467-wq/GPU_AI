/*
 profile-data.js — simple profile helpers using api.me
*/
import { api } from './api.js';
import { auth } from './auth.js';

export async function loadProfile(){
  const token = auth.currentToken();
  if(!token) throw { status:401, message: 'Not authenticated' };
  const resp = await api.me({token});
  return resp;
}