const socket = io(window.location.origin, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

let selectedAvatar = 'default-avatar.png';

// Form toggle
function showRegister() {
  document.getElementById('loginCard').classList.add('hidden');
  document.getElementById('registerCard').classList.remove('hidden');
}

function showLogin() {
  document.getElementById('registerCard').classList.add('hidden');
  document.getElementById('loginCard').classList.remove('hidden');
}

// Password toggle
function togglePassword(inputId) {
  const input = document.getElementById(inputId);
  const icon = input.parentElement.querySelector('.toggle-password i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.classList.replace('fa-eye', 'fa-eye-slash');
  } else {
    input.type = 'password';
    icon.classList.replace('fa-eye-slash', 'fa-eye');
  }
}

// Avatar selection
document.querySelectorAll('.avatar-option').forEach(option => {
  option.addEventListener('click', () => {
    document.querySelectorAll('.avatar-option').forEach(o => o.classList.remove('selected'));
    option.classList.add('selected');
    selectedAvatar = option.dataset.avatar;
  });
});

// Login
document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('.auth-btn');
  btn.classList.add('loading');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Giriş yapılıyor...';

  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;

  socket.emit('login', { email, password }, (response) => {
    btn.classList.remove('loading');
    btn.innerHTML = '<span>Giriş Yap</span><i class="fas fa-arrow-right"></i>';

    if (response.success) {
      // Kullanıcı bilgilerini sakla
      sessionStorage.setItem('user', JSON.stringify(response.user));
      sessionStorage.setItem('servers', JSON.stringify(response.servers));
      sessionStorage.setItem('friends', JSON.stringify(response.friends));
      sessionStorage.setItem('pendingRequests', JSON.stringify(response.pendingRequests));
      sessionStorage.setItem('dmContacts', JSON.stringify(response.dmContacts));
      sessionStorage.setItem('socketId', socket.id);
      sessionStorage.setItem('_p', password); // Reconnect için

      // Ana sayfaya yönlendir
      window.location.href = '/app.html';
    } else {
      document.getElementById('loginError').textContent = response.error;
      setTimeout(() => {
        document.getElementById('loginError').textContent = '';
      }, 5000);
    }
  });
});

// Register
document.getElementById('registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('.auth-btn');
  btn.classList.add('loading');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Hesap oluşturuluyor...';

  const username = document.getElementById('regUsername').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;

  socket.emit('register', { username, email, password, avatar: selectedAvatar }, (response) => {
    btn.classList.remove('loading');
    btn.innerHTML = '<span>Kayıt Ol</span><i class="fas fa-rocket"></i>';

    if (response.success) {
      // Otomatik giriş yap
      socket.emit('login', { email, password }, (loginResponse) => {
        if (loginResponse.success) {
          sessionStorage.setItem('user', JSON.stringify(loginResponse.user));
          sessionStorage.setItem('servers', JSON.stringify(loginResponse.servers));
          sessionStorage.setItem('friends', JSON.stringify(loginResponse.friends));
          sessionStorage.setItem('pendingRequests', JSON.stringify(loginResponse.pendingRequests));
          sessionStorage.setItem('dmContacts', JSON.stringify(loginResponse.dmContacts));
          sessionStorage.setItem('_p', password); // Reconnect için
          window.location.href = '/app.html';
        }
      });
    } else {
      document.getElementById('registerError').textContent = response.error;
      setTimeout(() => {
        document.getElementById('registerError').textContent = '';
      }, 5000);
    }
  });
});