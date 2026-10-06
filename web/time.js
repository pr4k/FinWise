/* Convert a browser-local datetime input to RFC 3339 with its actual offset. */
(() => {
  function localTimestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('Enter a valid date and time.');
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.getFullYear() !== Number(value.slice(0,4)) ||
        date.getMonth()+1 !== Number(value.slice(5,7)) || date.getDate() !== Number(value.slice(8,10)) ||
        date.getHours() !== Number(value.slice(11,13)) || date.getMinutes() !== Number(value.slice(14,16))) {
      throw new Error('This local date and time does not exist in your timezone.');
    }
    const minutes = -date.getTimezoneOffset();
    const sign = minutes < 0 ? '-' : '+';
    const offset = `${sign}${String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')}:${String(Math.abs(minutes)%60).padStart(2,'0')}`;
    return `${value.length===16 ? value+':00' : value}${offset}`;
  }
  window.finwiseTime = {localTimestamp};
})();
