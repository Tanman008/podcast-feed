// Loads .env.local before any module that reads process.env initialises.
// Import this as the very first line of any worker or script entry point.
import { config } from 'dotenv';
config({ path: '.env.local' });
