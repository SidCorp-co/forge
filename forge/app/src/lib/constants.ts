import Constants from 'expo-constants';

const devApi = 'http://localhost:8080/api';
const devWs = 'ws://localhost:8080/ws';

export const API_URL = Constants.expoConfig?.extra?.apiUrl ?? devApi;
export const WS_URL = Constants.expoConfig?.extra?.wsUrl ?? devWs;
