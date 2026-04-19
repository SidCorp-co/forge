import Constants from 'expo-constants';

const devApi = 'http://localhost:1337/api';
const devWs = 'ws://localhost:1337/ws';

export const API_URL = Constants.expoConfig?.extra?.apiUrl ?? devApi;
export const WS_URL = Constants.expoConfig?.extra?.wsUrl ?? devWs;
