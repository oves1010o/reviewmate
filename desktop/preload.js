const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

// 화면(renderer)이 쓸 수 있는 기능만 골라서 노출
contextBridge.exposeInMainWorld('api', {
  login: call('auth:login'),
  logout: call('auth:logout'),
  me: call('auth:me'),
  naverStatus: call('naver:status'),
  naverLogin: call('naver:login'),
  naverLogout: call('naver:logout'),
  placeReviews: call('place:reviews'),
  placeReply: call('place:reply'),
  storeReviews: call('store:reviews'),
  storeReply: call('store:reply'),
  generate: call('ai:generate'),
  openCharge: call('open:charge')
});
