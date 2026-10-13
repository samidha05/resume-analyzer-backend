const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');

// Simple in-memory cache: same search within 6 hours = no new API call
const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

/* ── Source 1: JSearch (primary) ── */
async function fetchFromJSearch(query, location) {
  const q = location ? `${query} jobs in ${location}` : `${query} jobs in India`;

  const response = await axios.get('https://jsearch.p.rapidapi.com/search-v2', {
    params: { query: q, page: 1, num_pages: 1, country: 'in' },
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
    },
    timeout: 60000
  });

  const body = response.data;

  // Log the real shape once so we can see it
  console.log('JSearch response keys:', Object.keys(body || {}));
  console.log('JSearch data type:', Array.isArray(body?.data) ? 'array' : typeof body?.data,
    body?.data && !Array.isArray(body.data) ? Object.keys(body.data) : '');

  // Find the list of jobs wherever it is
  let list = [];
  if (Array.isArray(body?.data)) list = body.data;
  else if (Array.isArray(body?.data?.jobs)) list = body.data.jobs;
  else if (Array.isArray(body?.data?.data)) list = body.data.data;
  else if (Array.isArray(body?.jobs)) list = body.jobs;

  return list.map(job => ({
    id: job.job_id,
    title: job.job_title,
    company: job.employer_name || 'Company not specified',
    location:
      [job.job_city, job.job_state].filter(Boolean).join(', ') ||
      job.job_country ||
      'Location not specified',
    description: (job.job_description || '').slice(0, 220),
    salaryMin: job.job_min_salary || null,
    salaryMax: job.job_max_salary || null,
    postedAt: job.job_posted_at_datetime_utc,
    applyUrl: job.job_apply_link
  }));
}

/* ── Source 2: Adzuna (fallback, your original code) ── */
async function fetchFromAdzuna(query, location) {
  const response = await axios.get('https://api.adzuna.com/v1/api/jobs/in/search/1', {
    params: {
      app_id: process.env.ADZUNA_APP_ID,
      app_key: process.env.ADZUNA_APP_KEY,
      results_per_page: 20,
      what: query,
      where: location || undefined,
      'content-type': 'application/json'
    }
  });

  return (response.data.results || []).map(job => ({
    id: job.id,
    title: job.title,
    company: job.company?.display_name || 'Company not specified',
    location: job.location?.display_name || 'Location not specified',
    description: (job.description || '').slice(0, 220),
    salaryMin: job.salary_min || null,
    salaryMax: job.salary_max || null,
    postedAt: job.created,
    applyUrl: job.redirect_url
  }));
}

// @route   GET /api/jobs/search?query=java+developer&location=amravati
router.get('/search', protect, async (req, res) => {
  try {
    const query = (req.query.query || '').trim();
    const location = (req.query.location || '').trim();

    if (query.length < 2) {
      return res.status(400).json({ success: false, message: 'Please enter a job title or domain to search' });
    }

    const key = `${query}|${location}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) {
      return res.json({ success: true, count: hit.data.length, data: hit.data, cached: true });
    }

    let jobs = [];

    try {
      jobs = await fetchFromJSearch(query, location);
    } catch (err) {
      console.error('JSearch failed:', err.response?.status, err.response?.data || err.message);
    }

    if (jobs.length === 0) {
      try {
        jobs = await fetchFromAdzuna(query, location);
      } catch (err) {
        console.error('Adzuna failed:', err.response?.data || err.message);
      }
    }

    if (jobs.length > 0) cache.set(key, { time: Date.now(), data: jobs });

    res.json({ success: true, count: jobs.length, data: jobs });
  } catch (error) {
    console.error('Job search error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch jobs. Please try again.' });
  }
});

module.exports = router;