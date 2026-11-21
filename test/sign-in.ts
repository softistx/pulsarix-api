export const SignIn = `mutation($input: SignInInput!) {
  signIn(input: $input) { status session { token viewer { email name language permissions } } }
}`;
