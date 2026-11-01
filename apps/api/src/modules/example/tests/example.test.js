const { greet } = require('../index');
test('greet', () => expect(greet('yv')).toBe('HELLO YV!'));
