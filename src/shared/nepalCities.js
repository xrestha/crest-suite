// Cities an outlet can pick for its weather (S784, Settings → Weather). The weather is read for
// the city, not the street, which is as fine as a forecast grid resolves anyway. Coordinates are
// two decimals (about a kilometre): MET Norway asks for no more than four, and the weather-forecast
// Edge Function rounds to two so neighbouring outlets share one cached fetch.
//
// A picker rather than the device's location: vercel.json's Permissions-Policy sets
// `geolocation=()`, and loosening a security header to fill in one form field is the wrong trade.
// Every entry must sit inside the settings_weather_coords_nepal CHECK (nepalCities.test.js).
export const NEPAL_BOX = { latMin: 26.3, latMax: 30.5, lonMin: 80.0, lonMax: 88.3 }

export const NEPAL_CITIES = [
  { key: 'kathmandu', name: 'Kathmandu', lat: 27.72, lon: 85.32 },
  { key: 'lalitpur', name: 'Lalitpur (Patan)', lat: 27.66, lon: 85.32 },
  { key: 'bhaktapur', name: 'Bhaktapur', lat: 27.67, lon: 85.43 },
  { key: 'dhulikhel', name: 'Dhulikhel', lat: 27.62, lon: 85.55 },
  { key: 'nagarkot', name: 'Nagarkot', lat: 27.72, lon: 85.52 },
  { key: 'pokhara', name: 'Pokhara', lat: 28.21, lon: 83.99 },
  { key: 'bharatpur', name: 'Bharatpur (Chitwan)', lat: 27.68, lon: 84.43 },
  { key: 'sauraha', name: 'Sauraha (Chitwan)', lat: 27.58, lon: 84.50 },
  { key: 'hetauda', name: 'Hetauda', lat: 27.43, lon: 85.03 },
  { key: 'birgunj', name: 'Birgunj', lat: 27.01, lon: 84.88 },
  { key: 'janakpur', name: 'Janakpur', lat: 26.73, lon: 85.93 },
  { key: 'rajbiraj', name: 'Rajbiraj', lat: 26.54, lon: 86.75 },
  { key: 'biratnagar', name: 'Biratnagar', lat: 26.45, lon: 87.27 },
  { key: 'itahari', name: 'Itahari', lat: 26.66, lon: 87.27 },
  { key: 'dharan', name: 'Dharan', lat: 26.81, lon: 87.28 },
  { key: 'damak', name: 'Damak', lat: 26.66, lon: 87.70 },
  { key: 'birtamod', name: 'Birtamod', lat: 26.65, lon: 87.99 },
  { key: 'ilam', name: 'Ilam', lat: 26.91, lon: 87.92 },
  { key: 'namche', name: 'Namche Bazaar', lat: 27.80, lon: 86.71 },
  { key: 'gorkha', name: 'Gorkha', lat: 28.00, lon: 84.63 },
  { key: 'bandipur', name: 'Bandipur', lat: 27.94, lon: 84.41 },
  { key: 'jomsom', name: 'Jomsom', lat: 28.78, lon: 83.73 },
  { key: 'tansen', name: 'Tansen (Palpa)', lat: 27.87, lon: 83.55 },
  { key: 'butwal', name: 'Butwal', lat: 27.70, lon: 83.45 },
  { key: 'bhairahawa', name: 'Bhairahawa (Siddharthanagar)', lat: 27.50, lon: 83.45 },
  { key: 'lumbini', name: 'Lumbini', lat: 27.48, lon: 83.28 },
  { key: 'ghorahi', name: 'Ghorahi (Dang)', lat: 28.03, lon: 82.48 },
  { key: 'tulsipur', name: 'Tulsipur (Dang)', lat: 28.13, lon: 82.30 },
  { key: 'nepalgunj', name: 'Nepalgunj', lat: 28.05, lon: 81.62 },
  { key: 'birendranagar', name: 'Birendranagar (Surkhet)', lat: 28.60, lon: 81.63 },
  { key: 'dhangadhi', name: 'Dhangadhi', lat: 28.69, lon: 80.62 },
  { key: 'mahendranagar', name: 'Mahendranagar (Bhimdatta)', lat: 28.97, lon: 80.18 },
]

export const cityByKey = key => NEPAL_CITIES.find(c => c.key === key) || null
