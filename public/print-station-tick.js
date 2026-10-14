// The print station page's clock (S837). A page left open all day in a background or covered
// window has its own timers slowed to once a minute by Chrome; a worker's timer keeps its pace, so
// tickets keep printing within seconds. It only says "tick"; the page decides what to do with it.
setInterval(function () { postMessage('tick') }, 2000)
