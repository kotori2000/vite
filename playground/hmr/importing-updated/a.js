const val = 'a02'
document.querySelector('.importing-reloaded').innerHTML += `a.js: ${val}<br>`

export default val

if (import.meta.hot) {
  import.meta.hot.accept()
}
