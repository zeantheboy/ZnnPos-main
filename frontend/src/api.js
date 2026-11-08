import axios from 'axios';
import toast from 'react-hot-toast';

const localHost = window.location.hostname || 'localhost';
const API_BASE_URL = window.location.protocol === 'https:'
  ? '/api'
  : `http://${localHost}:3001/api`;

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 5000, // 5 second timeout
});

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('znnpos_auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor for generic error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // If we want to globally handle errors with toast, we can do it here.
    // However, some components might want to handle it themselves.
    // We'll log it and let components catch it if needed.
    console.error('API Error:', error);
    
    if (error.code === 'ECONNABORTED' || error.message === 'Network Error') {
        toast.error('Network error. Is the backend running?');
    }

    return Promise.reject(error);
  }
);

export default api;
