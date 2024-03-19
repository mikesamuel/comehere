// Can drive into a switch block by synthesizing
// fall-through cases using sentinel values.

let vowels = 'aeiou';

switch (vowels[(Math.random() * 5) | 0]) {
  case 'a':
    console.log('A');
    break;
  case 'e':
    console.log('E');
    COMEHERE:with('in case e') {
      console.log('got to case e');
    }
    break;
  case 'i':
    console.log('I');
    break;
  case 'o':
    console.log('O');
    break;
  case 'u':
    console.log('U');
    break;
}
