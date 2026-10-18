import axios from 'axios'

// A shared axios client whose base address comes from an environment variable.
export const http = axios.create({ baseURL: import.meta.env.VITE_API_URL })
