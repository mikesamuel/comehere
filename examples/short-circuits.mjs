export let x =
  Math.random()
  ? (() => {
      COMEHERE:with('In ? of hook') {
        console.log('in ?');
      }
      return 1;
    })()
  : 0;
