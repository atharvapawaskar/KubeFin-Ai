import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Attach bearer token if stored
apiClient.interceptors.request.use((config) => {
  try {
    const token = localStorage.getItem('kubefin_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  } catch {
    // LocalStorage unavailable
  }
  return config
})
